import type Docker from 'dockerode';
import { expect } from 'chai';
import DockerGC from '../build/index';
import { makeImage } from './lib/common';

const repoOf = (ref: string) => ref.replace(/(@.*|:[^/]*)$/, '');

// A fake docker that models how the (graphdriver) engine removes references:
// https://github.com/moby/moby/blob/docker-v29.0.0/daemon/images/image_delete.go
// - removing a tag also removes the digests of the same repository if no other
//   tag of that repository remains
// - the image is only deleted once no references remain
const createFakeDocker = (id: string, refs: string[]) => {
	const remaining = new Set(refs);
	const removed: string[] = [];
	let deleted = false;
	const notFound = () =>
		Promise.reject(
			Object.assign(new Error('no such image'), { statusCode: 404 }),
		);
	const fake = {
		removed,
		isDeleted: () => deleted,
		listImages: () =>
			Promise.resolve([
				makeImage(id, '', {
					tags: refs.filter((r) => !r.includes('@')),
					digests: refs.filter((r) => r.includes('@')),
				}),
			]),
		listContainers: () => Promise.resolve([]),
		getImage: (ref: string) => ({
			remove: () => {
				removed.push(ref);
				if (deleted) {
					return notFound();
				}
				if (ref === id) {
					if (remaining.size > 1) {
						return Promise.reject(
							Object.assign(new Error('referenced in multiple repositories'), {
								statusCode: 409,
							}),
						);
					}
					deleted = true;
					return Promise.resolve([
						...[...remaining].map((r) => ({ Untagged: r })),
						{ Deleted: id },
					]);
				}
				if (!remaining.has(ref)) {
					return notFound();
				}
				remaining.delete(ref);
				const response: Array<{ Untagged?: string; Deleted?: string }> = [
					{ Untagged: ref },
				];
				const repo = repoOf(ref);
				if (
					!ref.includes('@') &&
					![...remaining].some((r) => !r.includes('@') && repoOf(r) === repo)
				) {
					for (const r of [...remaining]) {
						if (r.includes('@') && repoOf(r) === repo) {
							remaining.delete(r);
							response.push({ Untagged: r });
						}
					}
				}
				if (remaining.size === 0) {
					deleted = true;
					response.push({ Deleted: id });
				}
				return Promise.resolve(response);
			},
		}),
	};
	return fake;
};

const createGC = (docker: ReturnType<typeof createFakeDocker>) => {
	const gc = new DockerGC();
	Object.assign(gc, { docker: docker as unknown as Docker });
	return gc;
};

describe('Image removal', function () {
	let consoleLog: typeof console.log;
	before(function () {
		consoleLog = console.log;
		console.log = () => {
			// noop
		};
	});
	after(function () {
		console.log = consoleLog;
	});

	it('should delete an image that is also referenced by a digest of another repository', async function () {
		const docker = createFakeDocker('sha256:img1', [
			'foo:1',
			'foo@sha256:aaa',
			'bar@sha256:aaa',
		]);
		await createGC(docker).garbageCollect(1);
		expect(docker.isDeleted()).to.equal(true);
	});

	it('should delete an image tagged in a repository other than the one it was pulled from', async function () {
		const docker = createFakeDocker('sha256:img1', [
			'some-repo:some-tag',
			'hello-world@sha256:aaa',
		]);
		await createGC(docker).garbageCollect(1);
		expect(docker.isDeleted()).to.equal(true);
	});

	it('should stop removing references once the image is deleted', async function () {
		const docker = createFakeDocker('sha256:img1', [
			'foo:1',
			'foo:2',
			'foo@sha256:aaa',
		]);
		const removals: string[] = [];
		const gc = createGC(docker);
		gc.metrics.on('imageRemoved', (removalType) => removals.push(removalType));
		await gc.garbageCollect(1);
		expect(docker.isDeleted()).to.equal(true);
		expect(docker.removed).to.deep.equal(['foo:1', 'foo:2']);
		expect(removals).to.deep.equal(['tag', 'tag']);
	});

	it('should delete an untagged image by its digests', async function () {
		const docker = createFakeDocker('sha256:img1', [
			'foo@sha256:aaa',
			'bar@sha256:aaa',
		]);
		await createGC(docker).garbageCollect(1);
		expect(docker.isDeleted()).to.equal(true);
		expect(docker.removed).to.deep.equal(['foo@sha256:aaa', 'bar@sha256:aaa']);
	});

	it('should delete an image without any references by its id', async function () {
		const docker = createFakeDocker('sha256:img1', []);
		await createGC(docker).garbageCollect(1);
		expect(docker.isDeleted()).to.equal(true);
		expect(docker.removed).to.deep.equal(['sha256:img1']);
	});
});
