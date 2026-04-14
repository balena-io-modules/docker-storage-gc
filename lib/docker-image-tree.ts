import type Docker from 'dockerode';
import type { LayerMtimes } from './docker-event-stream';

const saneRepoAttrs = function (repoAttrs: string[] | undefined) {
	if (repoAttrs == null) {
		return [];
	}
	if (
		repoAttrs.includes('<none>:<none>') ||
		repoAttrs.includes('<none>@<none>')
	) {
		return [];
	} else {
		return repoAttrs;
	}
};

export const createNode = (id: string): ImageNode => ({
	id,
	size: 0,
	sharedSize: 0,
	uniqueSize: 0,
	repoTags: [],
	repoDigests: [],
	mtime: 0,
	children: {},
});

const getMtime = function (tree: ImageNode, layerMtimes: LayerMtimes) {
	// Collect mtime candidates from all possible keys (ID, tags, digests).
	// Container events store mtime under the `from` field which may be a tag,
	// while stream init stores 0 under the sha256 ID. We need the most recent
	// value across all keys to avoid treating a recently-used image as stale.
	let max: number | undefined;
	const keys = [tree.id, ...tree.repoTags, ...tree.repoDigests];
	for (const key of keys) {
		const val = layerMtimes.get(key);
		if (val != null && (max == null || val > max)) {
			max = val;
		}
	}
	return max;
};

export interface ImageNode {
	id: string;
	size: number;
	/**
	 * Size of layers shared with other images, as reported by the engine when
	 * listImages is called with `shared-size=1`. The unique on-disk contribution
	 * of this image is `size - sharedSize`. Defaults to 0 if the engine did not
	 * report it (older engines, or the option was not requested).
	 */
	sharedSize: number;
	/** `Math.max(0, size - sharedSize)` — precomputed to avoid repeated calculation during sort. */
	uniqueSize: number;
	repoTags: string[];
	repoDigests: string[];
	mtime: NonNullable<LayerMtimes extends Map<any, infer U> ? U : never>;
	children: Record<string, ImageNode>;
	isUsedByAContainer?: boolean;
}

export const createTree = function (
	images: Docker.ImageInfo[],
	containers: Docker.ContainerInfo[],
	layerMtimes: LayerMtimes,
): ImageNode {
	const now = Math.floor(Date.now() / 1000); // unix seconds, matching Docker event `time` field
	const usedImageIds = new Set(containers.map((c) => c.ImageID));
	const tree: {
		[key: string]: ImageNode;
	} = {};
	const root =
		'0000000000000000000000000000000000000000000000000000000000000000';

	for (const image of images) {
		const node = (tree[image.Id] ??= createNode(image.Id));
		const parentId = image.ParentId || root;
		const parent = (tree[parentId] ??= createNode(parentId));

		node.repoTags = saneRepoAttrs(image.RepoTags);
		node.repoDigests = saneRepoAttrs(image.RepoDigests);
		node.size = image.Size;
		// Engines that don't implement shared-size return -1. Treat that as 0
		// so we fall back to counting the full chain size (pre-shared-size
		// behaviour) rather than silently inflating reclaim estimates.
		node.sharedSize = image.SharedSize >= 0 ? image.SharedSize : 0;
		node.uniqueSize = Math.max(0, node.size - node.sharedSize);
		// If we haven't seen the image at all then assume it is brand new and default it's
		// mtime to `now` to avoid removing it
		node.mtime = getMtime(node, layerMtimes) ?? now;
		node.isUsedByAContainer = usedImageIds.has(image.Id);
		parent.children[image.Id] = node;
	}

	tree[root].mtime = now;
	tree[root].isUsedByAContainer = false;
	return tree[root];
};

export async function dockerImageTree(
	docker: Docker,
	layerMtimes: LayerMtimes,
) {
	const [images, containers] = await Promise.all([
		// `shared-size` asks the engine to populate ImageInfo.SharedSize so we
		// can subtract it from Size when computing reclaimable space. Without
		// this, every shared layer is counted once per image that references
		// it, inflating reclaim estimates by 10-20x on builder workers.
		docker.listImages({
			all: true,
			// @ts-expect-error `shared-size` works but isn't in dockerode's typings yet
			'shared-size': true,
		} satisfies Docker.ListImagesOptions as Docker.ListImagesOptions),
		docker.listContainers({ all: true }),
	]);
	return createTree(images, containers, layerMtimes);
}
