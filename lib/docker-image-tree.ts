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
		docker.listImages({ all: true }),
		docker.listContainers({ all: true }),
	]);
	return createTree(images, containers, layerMtimes);
}
