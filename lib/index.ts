import { EventEmitter } from 'eventemitter3';
import { DockerProgress } from 'docker-progress';
import Docker from 'dockerode';
import type { LayerMtimes } from './docker-event-stream';
import { dockerMtimeStream } from './docker-event-stream';
import type { ImageNode } from './docker-image-tree';
import { dockerImageTree } from './docker-image-tree';
import { getDocker } from './docker';
import { setTimeout } from 'timers/promises';
import type { Transform } from 'node:stream';

interface Events {
	numberImagesToRemove(n: number): void;
	gcRunTime(duration: number): void;
	imageRemoved(removalType: string): void;
	spaceReclaimed(reclaimSpace: number): void;
	imageRemovalError(statusCode: string): void;
}
type Metrics = EventEmitter<Events>;
type RemovalType = 'tag' | 'digest' | 'id';

interface RemovableImageNode extends ImageNode {
	removed?: true;
	children: Record<string, RemovableImageNode>;
	parent?: RemovableImageNode;
}

const isCandidateForRemoval = (node: RemovableImageNode): boolean => {
	return (
		!node.isUsedByAContainer &&
		Object.values(node.children).every((n) => n.removed)
	);
};
const getUnusedTreeLeafs = function (
	tree: RemovableImageNode,
	result: RemovableImageNode[] = [],
): RemovableImageNode[] {
	if (!tree.removed) {
		const children = Object.values(tree.children).filter((n) => !n.removed);
		if (children.length === 0 && !tree.isUsedByAContainer) {
			result.push(tree);
		} else {
			for (const child of children) {
				// We must ensure the parent is set so that we can re-check the parent
				// as a candidate for removal when its children are removed
				child.parent = tree;
				getUnusedTreeLeafs(child, result);
			}
		}
	}
	return result;
};

const sortBy = <T extends object>(key: keyof T): ((a: T, b: T) => number) => {
	return (a, b) => (a[key] > b[key] ? 1 : b[key] > a[key] ? -1 : 0);
};
const mtimeSort = sortBy('mtime');
// Sort by the reclaimable (unique) bytes of each image, not the full chain
// size. Prioritising full chain size would pop images whose removal frees
// almost nothing because all their layers are shared with other images.
const uniqueSizeSort = sortBy('uniqueSize');

/**
 * This will mutate the passed in tree, marking the images to be removed as removed.
 * Do not re-use the tree for multiple calls to this function as it will cause issues.
 */
const getImagesToRemove = function (
	tree: RemovableImageNode,
	reclaimSpace: number,
	metrics: Metrics,
): RemovableImageNode[] {
	// Removes the oldest, largest leafs first.
	// This should avoid trying to remove images with children.
	const result = [];
	let size = 0;
	const leafs = getUnusedTreeLeafs(tree);
	const resort = () => {
		leafs.sort((a, b) => {
			// mtime desc, unique-size asc — pop() removes from the end, so
			// oldest+largest-unique gets evicted first.
			return -mtimeSort(a, b) || uniqueSizeSort(a, b);
		});
	};
	resort();
	while (size < reclaimSpace) {
		if (leafs.length === 0) {
			break;
		}
		const leaf = leafs.pop()!;
		leaf.removed = true;
		if (leaf !== tree) {
			// don't remove the tree root
			result.push(leaf);
			// Credit only the layers unique to this image. The engine reports
			// `size` as the sum of every layer in the image's chain, including
			// layers shared with other images on disk. Summing raw `size`
			// across removals over-counts shared layers and makes GC think it
			// reclaimed far more than it did. `size - sharedSize` is a
			// conservative floor on the actual reclaim; if cascading removals
			// also drop the last reference to a shared layer, the extra
			// reclaim is accounted for when that image is popped in turn.
			size += leaf.uniqueSize;
			if (leaf.parent != null && isCandidateForRemoval(leaf.parent)) {
				// If the parent is now a candidate for deletion then add to the potential leafs and resort them
				leafs.push(leaf.parent);
				resort();
			}
		}
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
			.on('end', () => {
				resolve(Buffer.concat(chunks).toString());
			});
	});

// A multi-arch image, so that the daemon pulls the variant for its own platform
const BASE_IMAGE = 'alpine:3.23';

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
	private currentMtimes: LayerMtimes = new Map();
	private mtimeStream: Transform | undefined;

	public setHostname(hostname: string): void {
		this.host = hostname;
	}

	public async setDocker(hostObj: Docker.DockerOptions): Promise<void> {
		this.currentMtimes = new Map();
		this.dockerProgress = new DockerProgress({
			docker: new Docker(hostObj),
		});
		const docker = getDocker(hostObj);
		this.docker = docker;
		// Check that we can connect to the daemon
		await docker.ping();
	}

	public minDelayMs = 1000;
	public maxDelayMs = 60000;
	private async restartMtimeStream(attempts = 0) {
		const delayMs = Math.min(2 ** attempts * this.minDelayMs, this.maxDelayMs);
		await setTimeout(delayMs);
		try {
			await this.setupMtimeStream();
		} catch ($err) {
			console.error('Error restarting mtime stream:', $err);
			void this.restartMtimeStream(attempts + 1);
		}
	}

	public async setupMtimeStream(): Promise<void> {
		if (this.mtimeStream != null) {
			return;
		}
		this.mtimeStream = await dockerMtimeStream(this.docker, this.currentMtimes);
		this.mtimeStream.on('data', (layerMtimes: LayerMtimes) => {
			this.currentMtimes = layerMtimes;
		});
		this.mtimeStream.on('error', (err) => {
			console.error('Error in mtime stream:', err);
			this.destroyMtimeStream();
			void this.restartMtimeStream();
		});
	}

	public destroyMtimeStream(): void {
		if (this.mtimeStream != null) {
			this.mtimeStream.removeAllListeners();
			this.mtimeStream.destroy();
			this.mtimeStream = undefined;
		}
	}

	private async removeImage(image: RemovableImageNode): Promise<void> {
		// Removing the last tag of a repository also removes the digests of that
		// repository, but references from any other repository (eg the same image
		// pulled by digest from another repo) keep the image alive, so we keep
		// removing references until the engine reports that the image was deleted
		const references: Array<[string, RemovalType]> = [
			...image.repoTags.map((tag): [string, RemovalType] => [tag, 'tag']),
			...image.repoDigests.map((digest): [string, RemovalType] => [
				digest,
				'digest',
			]),
			[image.id, 'id'],
		];
		for (const [reference, removalType] of references) {
			console.log(
				`[GC ${this.host}]: Removing image: ${reference} (id: ${image.id}, size: ${image.size}, sharedSize: ${image.sharedSize}, mtime: ${image.mtime})`,
			);
			let response: Array<Partial<Docker.ImageRemoveInfo>>;
			try {
				response = await this.docker
					.getImage(reference)
					.remove({ noprune: true });
			} catch (e: any) {
				if (e.statusCode === 404) {
					console.log(
						`[GC ${this.host}]: Image already removed: ${reference} (id: ${image.id})`,
					);
					continue;
				}
				if (e.statusCode === 409) {
					console.log(
						`[GC ${this.host}]: Image has dependent children, skipping: ${reference} (id: ${image.id})`,
					);
					continue;
				}
				throw e;
			}
			this.metrics.emit('imageRemoved', removalType);
			if (response.some(({ Deleted }) => Deleted === image.id)) {
				return;
			}
		}
	}

	public async garbageCollect(
		reclaimSpace: number,
		attemptAll = false,
	): Promise<void> {
		let err: any;
		const startTime = process.hrtime();
		this.metrics.emit('spaceReclaimed', reclaimSpace);

		const tree = await dockerImageTree(this.docker, this.currentMtimes);
		const images = getImagesToRemove(tree, reclaimSpace, this.metrics);
		for (const image of images) {
			try {
				await this.removeImage(image);
			} catch (e: any) {
				this.metrics.emit('imageRemovalError', e.statusCode);
				console.log(`[GC ${this.host}]: Failed to remove image: `, image);
				console.log(e);
				if (attemptAll) {
					err ??= e;
				} else {
					recordGcRunTime(startTime, this.metrics);
					throw e;
				}
			}
		}
		recordGcRunTime(startTime, this.metrics);
		if (err != null) {
			throw err;
		}
	}

	private async getOutput(image: string, command: string[]): Promise<string> {
		const [, container] = await (this.docker.run(
			image,
			command,
			// @ts-expect-error -- The typings expect an array of streams but in reality they're optional
			undefined,
		) as Promise<[unknown, Docker.Container]>);
		try {
			const logs = await container.logs({ stdout: true, follow: true });
			return await streamToString(logs);
		} finally {
			await container.wait();
			await container.remove();
		}
	}

	public async getDaemonFreeSpace(): Promise<{
		used: number;
		total: number;
		free: number;
	}> {
		// Ensure the image is available (if it is this is essentially a no-op)
		await this.dockerProgress.pull(BASE_IMAGE, () => {
			// noop
		});

		const spaceStr = await this.getOutput(BASE_IMAGE, [
			'/bin/df',
			'-B',
			'1',
			'/',
		]);
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
	}
}
