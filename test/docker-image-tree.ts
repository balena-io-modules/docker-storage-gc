import type { ContainerInfo, ImageInfo } from 'dockerode';
import { expect } from 'chai';
import fs from 'fs';
import tk from 'timekeeper';
import { Stream } from 'node:stream';
import type { LayerMtimes } from '../build/docker-event-stream';
import { parseEventStream } from '../build/docker-event-stream';
import { createTree } from '../build/docker-image-tree';
import { docker, makeContainer, makeImage } from './lib/common';

const FROZEN_DATE = Date.UTC(2016, 0, 1);

const getLayerMtimes = async () => {
	const streamParsers = await parseEventStream(docker);

	let mtimes: LayerMtimes;
	await Stream.promises.pipeline(
		fs.createReadStream(__dirname + '/fixtures/docker-events.json'),
		...streamParsers,
		new Stream.Transform({
			objectMode: true,
			transform($data: LayerMtimes, _encoding, cb) {
				mtimes = $data;
				cb();
			},
		}),
	);
	return mtimes!;
};

describe('createTree', function () {
	it.skip('should work with empty input', function () {
		// TODO
	});

	it('should return a tree of images', async function () {
		const images = (
			await import('./fixtures/docker-images.json', {
				with: { type: 'json' },
			})
		).default as ImageInfo[];
		const containers = (
			await import('./fixtures/docker-containers.json', {
				with: { type: 'json' },
			})
		).default as ContainerInfo[];
		const mtimes = await getLayerMtimes();
		tk.freeze(FROZEN_DATE);
		const tree = createTree(images, containers, mtimes);
		tk.reset();
		const output = {
			id: '0000000000000000000000000000000000000000000000000000000000000000',
			size: 0,
			repoTags: [],
			repoDigests: [],
			mtime: 1451606400000000000,
			isUsedByAContainer: false,
			children: {
				'sha256:6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74':
					{
						id: 'sha256:6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74',
						size: 125151141,
						repoTags: [],
						repoDigests: [],
						mtime: 1451606400000000000,
						isUsedByAContainer: false,
						children: {
							'sha256:e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc':
								{
									id: 'sha256:e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc',
									size: 0,
									repoTags: ['project1'],
									repoDigests: [],
									mtime: 1451606400000000000,
									isUsedByAContainer: false,
									children: {
										'sha256:6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c':
											{
												id: 'sha256:6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c',
												size: 330389,
												repoTags: ['project2'],
												repoDigests: [],

												// eslint-disable-next-line no-loss-of-precision
												mtime: 1448576073085559863,
												isUsedByAContainer: false,
												children: {
													'sha256:80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea':
														{
															id: 'sha256:80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea',
															size: 98872,
															repoTags: [],
															repoDigests: [],
															mtime: 1451606400000000000,
															isUsedByAContainer: false,
															children: {},
														},
												},
											},
									},
								},
						},
					},
				'sha256:902b87aaaec929e80541486828959f14fa061f529ad7f37ab300d4ef9f3a0dbf':
					{
						id: 'sha256:902b87aaaec929e80541486828959f14fa061f529ad7f37ab300d4ef9f3a0dbf',
						size: 125151141,
						repoTags: [],
						repoDigests: [],
						mtime: 1451606400000000000,
						isUsedByAContainer: false,
						children: {
							'sha256:9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e':
								{
									id: 'sha256:9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e',
									size: 0,
									repoTags: ['resin/project3'],
									repoDigests: [],
									mtime: 1448576073203895800,
									isUsedByAContainer: false,
									children: {},
								},
						},
					},
				'sha256:5b0d59026729b68570d99bc4f3f7c31a2e4f2a5736435641565d93e7c25bd2c3':
					{
						id: 'sha256:5b0d59026729b68570d99bc4f3f7c31a2e4f2a5736435641565d93e7c25bd2c3',
						size: 125151141,
						repoTags: ['busybox:latest'],
						repoDigests: [
							'sha256:a8cf7ff6367c2afa2a90acd081b484cbded349a7076e7bdf37a05279f276bc12',
						],
						mtime: 1448576072937294800,
						isUsedByAContainer: true,
						children: {},
					},
			},
		};
		expect(tree).to.deep.equal(output);
	});

	describe('mtime resolution', function () {
		it('should resolve mtime from repoTags when ID key is 0', function () {
			const recentTime = 1700000000000000000;
			const images: ImageInfo[] = [
				makeImage('sha256:img1', '', { tags: ['myapp:latest'] }),
			];
			const mtimes: LayerMtimes = new Map<string, string | number>([
				['sha256:img1', 0], // set by parseEventStream init
				['myapp:latest', recentTime], // set by container event with from=tag
			]);

			tk.freeze(FROZEN_DATE);
			const tree = createTree(images, [], mtimes);
			tk.reset();

			// Should resolve to the tag-keyed mtime, not the ID-keyed 0
			expect(tree.children['sha256:img1'].mtime).to.equal(recentTime);
		});

		it('should resolve mtime from repoDigests when ID key is 0', function () {
			const recentTime = 1700000000000000000;
			const digest =
				'sha256:a8cf7ff6367c2afa2a90acd081b484cbded349a7076e7bdf37a05279f276bc12';
			const images: ImageInfo[] = [
				makeImage('sha256:img1', '', { digests: [digest] }),
			];
			const mtimes: LayerMtimes = new Map<string, string | number>([
				['sha256:img1', 0],
				[digest, recentTime],
			]);

			tk.freeze(FROZEN_DATE);
			const tree = createTree(images, [], mtimes);
			tk.reset();

			expect(tree.children['sha256:img1'].mtime).to.equal(recentTime);
		});

		it('should prefer most recent mtime when ID and tag are both non-zero', function () {
			const idTime = 1700000000000000000;
			const tagTime = 1600000000000000000;
			const images: ImageInfo[] = [
				makeImage('sha256:img1', '', { tags: ['myapp:latest'] }),
			];
			const mtimes: LayerMtimes = new Map<string, string | number>([
				['sha256:img1', idTime],
				['myapp:latest', tagTime],
			]);

			tk.freeze(FROZEN_DATE);
			const tree = createTree(images, [], mtimes);
			tk.reset();

			expect(tree.children['sha256:img1'].mtime).to.equal(idTime);
		});

		it('should default to now for images not in layerMtimes', function () {
			const images: ImageInfo[] = [
				makeImage('sha256:new-image', '', { tags: ['justbuilt:v1'] }),
			];
			tk.freeze(FROZEN_DATE);
			const tree = createTree(images, [], new Map());
			tk.reset();

			const expectedNow = FROZEN_DATE * 1e6;
			expect(tree.children['sha256:new-image'].mtime).to.equal(expectedNow);
		});

		it('should treat mtime=0 as old, not default to current time', function () {
			const images: ImageInfo[] = [
				makeImage('sha256:old', '', { tags: ['old:v1'] }),
			];
			const mtimes: LayerMtimes = new Map([['sha256:old', 0]]);

			tk.freeze(FROZEN_DATE);
			const tree = createTree(images, [], mtimes);
			tk.reset();

			expect(tree.children['sha256:old'].mtime).to.equal(0);
		});
	});

	describe('isUsedByAContainer', function () {
		it('should only check direct ImageID, not ancestor images', function () {
			// A container's image is protected, but its parent/base is not
			// directly marked — protection comes from tree structure instead
			const images: ImageInfo[] = [
				makeImage('sha256:base', '', { tags: ['ubuntu:20.04'] }),
				makeImage('sha256:child', 'sha256:base', {
					tags: ['myapp:v1'],
				}),
			];
			const containers: ContainerInfo[] = [makeContainer('sha256:child')];
			const mtimes: LayerMtimes = new Map();

			const tree = createTree(images, containers, mtimes);

			const base = tree.children['sha256:base'];
			const child = base.children['sha256:child'];
			expect(child.isUsedByAContainer).to.be.true;
			// Base is NOT directly marked — relies on tree structure for protection
			expect(base.isUsedByAContainer).to.be.false;
		});
	});
});
