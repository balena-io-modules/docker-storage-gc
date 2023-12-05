import Bluebird, { Disposer } from 'bluebird';
import _ from 'lodash';
import { EventEmitter } from 'eventemitter3';
import { DockerProgress } from 'docker-progress';
import Docker from 'dockerode';
import { LayerMtimes, dockerMtimeStream } from './docker-event-stream';
import { ImageNode, dockerImageTree } from './docker-image-tree';
import { getDocker } from './docker';

interface Events {
	numberImagesToRemove(n: number): void;
	gcRunTime(duration: number): void;
	imageRemoved(removalType: string): void;
	spaceReclaimed(reclaimSpace: number): void;
	imageRemovalError(statusCode: string): void;
}
type Metrics = EventEmitter<Events>;

interface RemovableImageNode extends ImageNode {
	removed?: true;
}

const getUnusedTreeLeafs = function (
	tree: RemovableImageNode,
	result: RemovableImageNode[] = [],
) {
	if (!tree.removed) {
		const children = _(tree.children)
			.values()
			.filter(_.negate(_.property('removed')))
			.value();
		if (children.length === 0 && !tree.isUsedByAContainer) {
			result.push(tree);
		} else {
			for (const child of children) {
				getUnusedTreeLeafs(child, result);
			}
		}
	}
	return result;
};

const getImagesToRemove = function (
	tree: RemovableImageNode,
	reclaimSpace: number,
	metrics: Metrics,
) {
	// Removes the oldest, largest leafs first.
	// This should avoid trying to remove images with children.
	tree = _.clone(tree);
	const result = [];
	let size = 0;
	while (size < reclaimSpace) {
		const leafs = _.orderBy(
			getUnusedTreeLeafs(tree),
			['mtime', 'size'],
			['asc', 'desc'],
		);
		if (leafs.length === 0) {
			break;
		}
		const leaf = leafs[0];
		if (leaf !== tree) {
			// don't remove the tree root
			result.push(leaf);
			size += leaf.size;
		}
		leaf.removed = true;
	}

	metrics.emit('numberImagesToRemove', result.length);
	return result;
};

const streamToString = (stream: NodeJS.ReadableStream) =>
	new Promise<string>(function (resolve, reject) {
		const chunks: Buffer[] = [];
		stream
			.on('error', reject)
			.on('data', (chunk) => chunks.push(chunk))
			.on('end', () => resolve(Buffer.concat(chunks).toString()));
	});

const recordGcRunTime = function (
	t0: ReturnType<NodeJS.HRTime>,
	metrics: Metrics,
) {
	const dt = process.hrtime(t0);
	const duration = dt[0] * 1000 + dt[1] / 1e6;
	metrics.emit('gcRunTime', duration);
};

export default class DockerGC {
	public metrics: Metrics = new EventEmitter<Events>();
	private host = 'unknown';
	private docker: Docker;
	private dockerProgress: DockerProgress;
	private currentMtimes: LayerMtimes = {};
	private baseImagePromise: Promise<string>;

	public setHostname(hostname: string): void {
		this.host = hostname;
	}

	public setDocker(hostObj: Docker.DockerOptions): Promise<void> {
		this.currentMtimes = {};
		hostObj = _.defaults({ Promise: Bluebird }, hostObj);
		this.dockerProgress = new DockerProgress({
			docker: new Docker(hostObj),
		});
		return getDocker(hostObj)
			.then((docker) => {
				// Docker info can take a while so do it here,
				// and don't wait on the results
				this.docker = docker;
				return (this.baseImagePromise = this.getDaemonArchitecture().then(
					function (arch) {
						switch (arch) {
							case 'arm':
								return 'arm32v6/alpine:3.6';
							case 'arm64':
								return 'arm64v8/alpine:3.6';
							case 'amd64':
								return 'alpine:3.6';
							default:
								throw new Error('Could not detect architecture of remote host');
						}
					},
				));
			})
			.then(() => {
				// noop
			});
	}

	public setupMtimeStream(): Promise<void> {
		return dockerMtimeStream(this.docker).then((stream) => {
			stream.on('data', (layerMtimes: LayerMtimes) => {
				this.currentMtimes = layerMtimes;
			});
		});
	}

	private removeImage(image: RemovableImageNode) {
		return (
			this.tryRemoveImageBy(image, image.repoTags, 'tag') ||
			this.tryRemoveImageBy(image, image.repoDigests, 'digest') ||
			this.tryRemoveImageBy(image, [image.id], 'id')
		);
	}

	private tryRemoveImageBy(
		image: RemovableImageNode,
		attributes: [string],
		removalType: 'tag' | 'digest' | 'id',
	): Promise<void>;
	private tryRemoveImageBy(
		image: RemovableImageNode,
		attributes: string[],
		removalType: 'tag' | 'digest' | 'id',
	): Promise<void> | undefined;
	private tryRemoveImageBy(
		image: RemovableImageNode,
		attributes: string[],
		removalType: 'tag' | 'digest' | 'id',
	): Promise<void> | undefined {
		if (attributes.length > 0) {
			return Bluebird.each(attributes, (attribute) => {
				console.log(
					`[GC (${this.host}] Removing image : ${attribute} (id: ${image.id})`,
				);
				return this.docker
					.getImage(attribute)
					.remove({ noprune: true })
					.then(() => {
						this.metrics.emit('imageRemoved', removalType);
					});
			}).then(() => {
				// noop
			});
		}
	}

	public garbageCollect(
		reclaimSpace: number,
		attemptAll = false,
	): Promise<void> {
		let err: any;
		const startTime = process.hrtime();
		this.metrics.emit('spaceReclaimed', reclaimSpace);
		return Bluebird.resolve(dockerImageTree(this.docker, this.currentMtimes))
			.then((tree) => {
				return getImagesToRemove(tree, reclaimSpace, this.metrics);
			})
			.each((image) => {
				return this.removeImage(image).catch((e) => {
					this.metrics.emit('imageRemovalError', e.statusCode);
					console.log(`[GC ${this.host}]: Failed to remove image: `, image);
					console.log(e);
					if (attemptAll) {
						err ??= e;
						return;
					} else {
						recordGcRunTime(startTime, this.metrics);
						throw e;
					}
				});
			})
			.then(() => {
				recordGcRunTime(startTime, this.metrics);
				if (err != null) {
					throw err;
				}
			});
	}

	private getOutput(image: string, command: string[]): Promise<string> {
		return Bluebird.using(this.runDisposer(image, command), (container) =>
			container
				.logs({ stdout: true, follow: true })
				.then((logs) => streamToString(logs)),
		);
	}

	private runDisposer(
		image: string,
		command: string[],
	): Disposer<Docker.Container> {
		const containerPromise: Promise<[unknown, Docker.Container]> =
			this.docker.run(
				image,
				command,
				// @ts-expect-error -- The typings expect an array of streams but in reality they're optional
				undefined,
			);
		return Bluebird.resolve(
			containerPromise.then(([, container]) => container),
		).disposer((container) => container.wait().then(() => container.remove()));
	}

	public getDaemonFreeSpace(): Promise<{
		used: number;
		total: number;
		free: number;
	}> {
		return Bluebird.resolve(this.baseImagePromise)
			.tap((baseImage) => {
				// Ensure the image is available (if it is this is essentially a no-op)
				return this.dockerProgress.pull(baseImage, _.noop);
			})
			.then((baseImage) => {
				return this.getOutput(baseImage, ['/bin/df', '-B', '1', '/']);
			})
			.then(function (spaceStr) {
				// First split the lines, as we're only interested in the second one
				const lines = spaceStr.trim().split(/\r?\n/);
				if (lines.length !== 2) {
					throw new Error('Coult not parse df output');
				}

				const parts = lines[1].split(/\s+/);
				const total = parseInt(parts[1], 10);
				const used = parseInt(parts[2], 10);
				const free = parseInt(parts[3], 10);
				return { used, total, free };
			});
	}

	private getDaemonArchitecture() {
		return this.docker.version().then(({ Arch }) => Arch);
	}
}
