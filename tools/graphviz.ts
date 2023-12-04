import type { ImageNode } from '../lib/docker-image-tree';

const id = (tree: ImageNode) => `foo_${tree.id.slice(0, 7)}`;

const label = function (tree: ImageNode) {
	const name = tree.repoTags[0] || '\\<none\\>:\\<none\\>';
	const mtime = new Date(tree.mtime!).toISOString();

	return `label="{ ${tree.id.slice(0, 13)} | ${name} | { ${mtime} | ${
		tree.size
	} } }"`;
};

const color = function (tree: ImageNode) {
	if (tree.repoTags.length === 0) {
		return 'color="black"';
	} else {
		return 'color="red"';
	}
};

const $createDot = function (tree: ImageNode): string[] {
	// define the node
	return (
		[`${id(tree)} [shape=record, ${label(tree)}, ${color(tree)}]`]
			// define all relations with child nodes
			.concat(
				Object.values(tree.children).map(
					(child) => `${id(tree)} -> ${id(child)}`,
				),
			)
			// recurse to children
			.concat(...Object.values(tree.children).map((child) => $createDot(child)))
	);
};

export function createDot(tree: ImageNode) {
	return 'digraph {\n' + $createDot(tree).join('\n') + '\n}\n';
}
