import type { ContainerInfo, ImageInfo } from 'dockerode';
import { expect } from 'chai';
import fs from 'fs';
import tk from 'timekeeper';
import es from 'event-stream';
import type { LayerMtimes } from '../build/docker-event-stream';
import { parseEventStream } from '../build/docker-event-stream';
import { createTree } from '../build/docker-image-tree';
import { getDocker } from '../build/docker';

const getLayerMtimes = async () => {
	const docker = getDocker({});
	const streamParser = await parseEventStream(docker);
	return await new Promise<LayerMtimes>(function (resolve, reject) {
		let mtimes: LayerMtimes;
		return fs
			.createReadStream(__dirname + '/fixtures/docker-events.json')
			.pipe(streamParser)
			.on('error', reject)
			.pipe(es.mapSync((data: LayerMtimes) => (mtimes = data)))
			.on('end', () => {
				resolve(mtimes);
			})
			.on('error', reject);
	});
};

describe('createTree', function () {
	it.skip('should work with empty input', function () {
		// TODO
	});

	it('should return a tree of images', async function () {
		const images = (
			await import('./fixtures/docker-images.json', {
				assert: { type: 'json' },
			})
		).default as ImageInfo[];
		const containers = (
			await import('./fixtures/docker-containers.json', {
				assert: { type: 'json' },
			})
		).default as ContainerInfo[];
		const mtimes = await getLayerMtimes();
		tk.freeze(Date.UTC(2016, 0, 1));
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
												// eslint-disable-next-line @typescript-eslint/no-loss-of-precision
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
});
