import { EventEmitter } from 'eventemitter3';
import { DockerProgress } from 'docker-progress';
import type Docker from 'dockerode';
import type { LayerMtimes } from './docker-event-stream';
import { dockerMtimeStream } from './docker-event-stream';
import type { ImageNode } from './docker-image-tree';
import { dockerImageTree } from './docker-image-tree';
import { getDocker } from './docker';
import { setTimeout } from 'timers/promises';
import { finished } from 'node:stream';
import type { Transform } from 'node:stream';

export type RemovalType = 'tag' | 'digest' | 'id';

export interface Events {
	/** The number of images selected for removal by a GC run */
	numberImagesToRemove(n: number): void;
	/** The duration of a GC run in milliseconds, emitted whether or not it succeeded */
	gcRunTime(duration: number): void;
	/** Emitted for every image reference that is successfully removed */
	imageRemoved(removalType: RemovalType): void;
	/** The amount of space a GC run was asked to reclaim, emitted at the start of the run */
	spaceReclaimed(reclaimSpace: number): void;
	/** The HTTP status code of a failed removal, `undefined` if the request itself failed */
	imageRemovalError(statusCode: number | undefined): void;
}
export type Metrics = EventEmitter<Events>;

interface RemovableImageNode extends ImageNode {
	removed?: true;
	children: Record<string, RemovableImageNode>;
	parent?: RemovableImageNode;
}

// A multi-arch image, so that the daemon pulls the variant for its own platform
const BASE_IMAGE = 'alpine:3.23';

// Images that must never be removed
const isKept = (node: RemovableImageNode): boolean =>
	node.isUsedByAContainer === true || node.repoTags.includes(BASE_IMAGE);

const isCandidateForRemoval = (node: RemovableImageNode): boolean => {
	return !isKept(node) && Object.values(node.children).every((n) => n.removed);
};
const getUnusedTreeLeafs = function (
	tree: RemovableImageNode,
	result: RemovableImageNode[] = [],
): RemovableImageNode[] {
	if (!tree.removed) {
		const children = Object.values(tree.children).filter((n) => !n.removed);
		if (children.length === 0 && !isKept(tree)) {
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
 * Yields the images to remove in eviction order: oldest mtime first, then
 * largest unique size. A parent becomes a candidate once all of its children
 * have been yielded. The caller decides when to stop, based on the free space
 * that it measures, because `uniqueSize` comes from a single `listImages`
 * snapshot and is not a reliable measure of what a removal frees.
 *
 * This will mutate the passed in tree, marking each yielded image as removed.
 * Do not re-use the tree for multiple calls to this function as it will cause issues.
 */
function* getImagesToRemove(
	tree: RemovableImageNode,
): Generator<RemovableImageNode, void, undefined> {
	// This should avoid trying to remove images with children.
	const leafs = getUnusedTreeLeafs(tree);
	const resort = () => {
		leafs.sort((a, b) => {
			// mtime desc, unique-size asc — pop() removes from the end, so
			// oldest+largest-unique gets evicted first.
			return -mtimeSort(a, b) || uniqueSizeSort(a, b);
		});
	};
	resort();
	while (leafs.length > 0) {
		const leaf = leafs.pop()!;
		leaf.removed = true;
		if (leaf === tree) {
			// don't remove the tree root
			continue;
		}
		yield leaf;
		// `sharedSize` is a static snapshot, so a parent whose layers were shared
		// only with its (now removed) children still reports them as shared. The
		// eviction order therefore under-ranks such parents, and the actual
		// reclaim is only known by measuring free space.
		if (leaf.parent != null && isCandidateForRemoval(leaf.parent)) {
			// If the parent is now a candidate for deletion then add to the potential leafs and resort them
			leafs.push(leaf.parent);
			resort();
		}
	}
}

/**
 * Parse the output of `df -B 1 <mountpoint>` for a single filesystem
 */
export const parseDfOutput = (output: string) => {
	const [header, ...lines] = output.trim().split(/\r?\n/);
	// busybox prints `1-blocks`, GNU coreutils `1B-blocks`
	if (
		!/^Filesystem\s+1B?-blocks\s+Used\s+Available\s+Use%\s+Mounted on$/.test(
			header,
		)
	) {
		throw new Error(`Could not parse df output: ${output}`);
	}
	// Join the remaining lines, as busybox prints long filesystem names on their
	// own line, eg `/dev/mapper/...\n   <total> <used> <free> <use%> /`
	const parts = lines.join(' ').trim().split(/\s+/);
	// <filesystem> <total> <used> <free> <use%> <mountpoint>
	if (parts.length !== 6 || !/^\d+%$/.test(parts[4]) || parts[5] !== '/') {
		throw new Error(`Could not parse df output: ${output}`);
	}
	const [total, used, free] = parts.slice(1, 4).map((part) => {
		const n = Number(part);
		if (!/^\d+$/.test(part) || !Number.isSafeInteger(n)) {
			throw new Error(`Could not parse df output: ${output}`);
		}
		return n;
	});
	return { used, total, free };
};

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
	private mtimeStreamSetup: Promise<void> | undefined;
	private mtimeStreamController: AbortController | undefined;
	// Whether an mtime stream has been requested, so that `setDocker` can
	// restart it on the new host even if a previous `setDocker` failed
	private mtimeStreamWanted = false;

	public setHostname(hostname: string): void {
		this.host = hostname;
	}

	public async setDocker(hostObj: Docker.DockerOptions): Promise<void> {
		// An existing mtime stream would keep watching the previous docker host
		const restartMtimeStream = this.mtimeStreamWanted;
		this.destroyMtimeStream();
		this.mtimeStreamWanted = restartMtimeStream;
		this.currentMtimes = new Map();
		const docker = getDocker(hostObj);
		this.docker = docker;
		// Share the instance so that images are pulled from the same daemon that
		// we run them on, `getDocker` resolves an empty `hostObj` differently to
		// dockerode's own defaults
		this.dockerProgress = new DockerProgress({ docker });
		// Check that we can connect to the daemon
		await docker.ping();
		// The stream may have been destroyed whilst we were waiting
		if (this.mtimeStreamWanted) {
			await this.setupMtimeStream();
		}
	}

	public minDelayMs = 1000;
	public maxDelayMs = 60000;
	private async restartMtimeStream(signal: AbortSignal, attempts = 0) {
		const delayMs = Math.min(2 ** attempts * this.minDelayMs, this.maxDelayMs);
		try {
			await setTimeout(delayMs, undefined, { signal });
		} catch {
			// The mtime stream was destroyed whilst we were waiting
			return;
		}
		try {
			await this.setupMtimeStream();
		} catch ($err) {
			if (signal.aborted) {
				return;
			}
			console.error('Error restarting mtime stream:', $err);
			void this.restartMtimeStream(signal, attempts + 1);
		}
	}

	public async setupMtimeStream(): Promise<void> {
		this.mtimeStreamWanted = true;
		// Share an in progress setup so that concurrent calls don't create multiple streams
		if (this.mtimeStreamSetup == null) {
			const setup = this.startMtimeStream().finally(() => {
				// A destroy may have replaced it with a newer setup in the meantime
				if (this.mtimeStreamSetup === setup) {
					this.mtimeStreamSetup = undefined;
				}
			});
			this.mtimeStreamSetup = setup;
		}
		await this.mtimeStreamSetup;
	}

	private async startMtimeStream(): Promise<void> {
		if (this.mtimeStream != null) {
			return;
		}
		// Aborted by `destroyMtimeStream`, to cancel an in progress setup or pending restart
		this.mtimeStreamController ??= new AbortController();
		const { signal } = this.mtimeStreamController;
		const stream = await dockerMtimeStream(this.docker, this.currentMtimes);
		if (signal.aborted) {
			stream.destroy();
			return;
		}
		this.mtimeStream = stream;
		stream.on('data', (layerMtimes: LayerMtimes) => {
			this.currentMtimes = layerMtimes;
		});
		// This covers both errors and the events request ending, eg when the
		// daemon restarts, which would otherwise leave us without a stream
		finished(stream, (err) => {
			if (this.mtimeStream !== stream) {
				// The stream was intentionally destroyed
				return;
			}
			console.error('Error in mtime stream:', err ?? 'stream ended');
			this.mtimeStream = undefined;
			stream.destroy();
			void this.restartMtimeStream(signal);
		});
	}

	public destroyMtimeStream(): void {
		this.mtimeStreamWanted = false;
		this.mtimeStreamController?.abort();
		this.mtimeStreamController = undefined;
		// A setup that is still in progress has been aborted, so later setups
		// must not wait on it
		this.mtimeStreamSetup = undefined;
		const stream = this.mtimeStream;
		if (stream != null) {
			this.mtimeStream = undefined;
			// Do not remove the listeners first, the pipeline relies on them to
			// destroy the underlying events request when this stream is destroyed
			stream.destroy();
		}
	}

	private async removeImage(image: RemovableImageNode): Promise<boolean> {
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
				return true;
			}
		}
		return false;
	}

	// How often to check free space between image removals, whichever comes first
	public freeSpaceCheckInterval = { images: 10, ms: 30_000 };

	/**
	 * Remove unused images, oldest first, until the daemon's free space has
	 * grown by `reclaimSpace` bytes since the start of the run, or until no
	 * candidates are left. Free space is measured with `getDaemonFreeSpace`
	 * at the start of the run and then in batches, see `freeSpaceCheckInterval`.
	 * A failure to measure free space at the start of the run or between
	 * removals stops the run and is thrown, regardless of `attemptAll`, so that
	 * a run never removes images without a target. A failure of the final
	 * measurement, taken when no candidates are left, is only logged.
	 *
	 * @param attemptAll keep removing images after a removal fails, and throw
	 * the first removal error once the run stops
	 */
	public async garbageCollect(
		reclaimSpace: number,
		attemptAll = false,
	): Promise<void> {
		let err: any;
		let removed = 0;
		const startTime = process.hrtime();
		this.metrics.emit('spaceReclaimed', reclaimSpace);

		try {
			// Also catches NaN, which would otherwise give a target that is never reached
			if (!(reclaimSpace > 0)) {
				console.log(
					`[GC ${this.host}]: Stopped: nothing to reclaim (reclaimSpace: ${reclaimSpace}), removed 0 images`,
				);
				return;
			}
			// Measure before listing images, so that a failure to measure stops
			// the run before it touches anything. Measuring may also pull the base
			// image, which then appears in the tree and is excluded from removal.
			const initialFree = (await this.getDaemonFreeSpace()).free;
			const targetFree = initialFree + reclaimSpace;
			let free = initialFree;
			let attemptsSinceCheck = 0;
			let lastCheck = Date.now();
			let targetReached = false;

			const tree = await dockerImageTree(this.docker, this.currentMtimes);
			for (const image of getImagesToRemove(tree)) {
				try {
					if (await this.removeImage(image)) {
						removed++;
					}
				} catch (e: any) {
					this.metrics.emit('imageRemovalError', e.statusCode);
					console.log(`[GC ${this.host}]: Failed to remove image: `, image);
					console.log(e);
					if (attemptAll) {
						err ??= e;
					} else {
						throw e;
					}
				}
				attemptsSinceCheck++;
				if (
					attemptsSinceCheck >= this.freeSpaceCheckInterval.images ||
					Date.now() - lastCheck >= this.freeSpaceCheckInterval.ms
				) {
					// A failure here propagates and stops the run, even with `attemptAll`
					free = (await this.getDaemonFreeSpace()).free;
					attemptsSinceCheck = 0;
					lastCheck = Date.now();
					if (free >= targetFree) {
						targetReached = true;
						break;
					}
				}
			}
			let freeLabel = 'after';
			if (!targetReached && attemptsSinceCheck > 0) {
				// Measure again so the final free space is accurate in the log
				try {
					free = (await this.getDaemonFreeSpace()).free;
					targetReached = free >= targetFree;
				} catch (e: any) {
					console.log(
						`[GC ${this.host}]: Failed to measure free space at the end of the run: ${e?.message ?? e}`,
					);
					freeLabel = 'last measured';
				}
			}
			console.log(
				`[GC ${this.host}]: Stopped: ${targetReached ? 'target reached' : 'no candidates left'}, removed ${removed} images, free bytes before: ${initialFree}, ${freeLabel}: ${free}, target: ${targetFree}`,
			);
		} finally {
			this.metrics.emit('numberImagesToRemove', removed);
			recordGcRunTime(startTime, this.metrics);
		}
		if (err != null) {
			throw err;
		}
	}

	private async getOutput(image: string, command: string[]): Promise<string> {
		const container = await this.docker.createContainer({
			Image: image,
			Cmd: command,
			Tty: true,
		});
		try {
			await container.start();
			const { StatusCode } = await container.wait();
			const logs = await container.logs({ stdout: true, follow: false });
			const output = logs.toString();
			if (StatusCode !== 0) {
				throw new Error(
					`${command.join(' ')} exited with code ${StatusCode}: ${output}`,
				);
			}
			return output;
		} finally {
			// Don't let a failure to clean up hide the result or the original error
			try {
				await container.remove({ force: true });
			} catch (e) {
				console.log(`[GC ${this.host}]: Failed to remove container:`, e);
			}
		}
	}

	private async ensureImage(image: string): Promise<void> {
		try {
			await this.docker.getImage(image).inspect();
		} catch (e: any) {
			if (e.statusCode !== 404) {
				throw e;
			}
			await this.dockerProgress.pull(image, () => {
				// noop
			});
		}
	}

	public async getDaemonFreeSpace(): Promise<{
		used: number;
		total: number;
		free: number;
	}> {
		// Only pull the image if it is missing, a pull always contacts the
		// registry, which counts towards registry rate limits and fails offline
		await this.ensureImage(BASE_IMAGE);

		const spaceStr = await this.getOutput(BASE_IMAGE, [
			'/bin/df',
			'-B',
			'1',
			'/',
		]);
		return parseDfOutput(spaceStr);
	}
}
