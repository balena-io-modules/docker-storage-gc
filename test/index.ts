import type Docker from 'dockerode';
import { expect } from 'chai';
import DockerGC from '../build/index';
import { getDocker } from '../build/docker';

const SKIP_GC_TEST = process.env.SKIP_GC_TEST === '1' || false;
const IMAGES = ['alpine:3.1', 'debian:squeeze', 'ubuntu:lucid'];

// TODO: Move it to a proper repo
// Same image (same id), different repo, different digest
const NONE_TAG_IMAGES = [
	'hello-world@sha256:8e3114318a995a1ee497790535e7b88365222a21771ae7e53687ad76563e8e76',
	'balenaplayground/hello-world@sha256:90659bf80b44ce6be8234e6ff90a1ac34acbeb826903b02cfa0da11c82cbc042',
];

const promiseToBool = async (p: Promise<unknown>): Promise<boolean> => {
	try {
		await p;
		return true;
	} catch {
		return false;
	}
};

const pullAsync = async function (docker: Docker, tag: string) {
	console.log(`[TEST] Pulling ${tag}`);
	const stream = await docker.pull(tag);
	return await new Promise(function (resolve, reject) {
		stream.resume();
		stream.once('error', reject);
		stream.once('end', resolve);
	});
};

// This test case is a little weird, it requires that no other images are present on
// the system to ensure that the correct one is being removed. Because of this, you
// can use the SKIP_GC_TEST env var to inform the test suite not to run this test
describe('Garbage collection', function () {
	let dockerStorage: DockerGC;
	let docker: Docker;
	beforeEach(async function () {
		dockerStorage = new DockerGC();
		// Use either local or CI docker
		const [$docker] = await Promise.all([
			getDocker({
				socketPath: '/tmp/dind/docker.sock',
			}),
			dockerStorage.setDocker({
				socketPath: '/tmp/dind/docker.sock',
			}),
		]);
		docker = $docker;
		return await dockerStorage.setupMtimeStream();
	});

	afterEach(function () {
		console.log('[afterEach] Cleaning up...');
		return IMAGES.concat(NONE_TAG_IMAGES).map(async (image) => {
			try {
				return await docker.getImage(image).remove();
			} catch {
				// ignore
			}
		});
	});

	it('should remove a image by tag', async function () {
		this.timeout(600000);

		await pullAsync(docker, IMAGES[0]);
		await docker.getImage(IMAGES[0]).inspect();
		await dockerStorage.garbageCollect(1);
		const imageFound = await promiseToBool(
			docker.getImage(IMAGES[0]).inspect(),
		);
		expect(imageFound).to.be.false;
	});

	it('should remove a image by digest if its tag == none', async function () {
		this.timeout(600000);

		await pullAsync(docker, NONE_TAG_IMAGES[0]);
		await docker.getImage(NONE_TAG_IMAGES[0]).inspect();
		await dockerStorage.garbageCollect(1);
		const imageFound = await promiseToBool(
			docker.getImage(NONE_TAG_IMAGES[0]).inspect(),
		);
		expect(imageFound).to.be.false;
	});

	it('should remove a image with tag == none even if it is in several repos', async function () {
		this.timeout(600000);

		for (const image of NONE_TAG_IMAGES) {
			await pullAsync(docker, image);
		}
		await docker.getImage(NONE_TAG_IMAGES[0]).inspect();
		await dockerStorage.garbageCollect(1);
		const imagesFound = await Promise.all(
			NONE_TAG_IMAGES.map((image) =>
				promiseToBool(docker.getImage(image).inspect()),
			),
		);
		expect(imagesFound).to.deep.equal([false, false]);
	});

	it('should remove all tags of an image', async function () {
		this.timeout(600000);
		if (SKIP_GC_TEST) {
			return;
		}

		// first pull some images, so we know in which order they are referenced
		await pullAsync(docker, IMAGES[0]);
		await docker
			.getImage(IMAGES[0])
			.tag({ repo: 'some-repo', tag: 'some-tag' });
		await dockerStorage.garbageCollect(1);
		const imagesFound = await promiseToBool(
			docker.getImage(IMAGES[0]).inspect(),
		);
		expect(imagesFound).to.be.false;
	});

	it('should remove the LRU image', async function () {
		this.timeout(600000);
		if (SKIP_GC_TEST) {
			return;
		}

		// first pull some images, so we know in which order they are referenced
		await pullAsync(docker, IMAGES[0]);
		await docker
			.getImage(IMAGES[0])
			.tag({ repo: 'some-repo', tag: 'some-tag' });
		for (const image of IMAGES.slice(1)) {
			await pullAsync(docker, image);
		}
		await dockerStorage.garbageCollect(1);
		const imagesFound = await Promise.all(
			IMAGES.map((image) => promiseToBool(docker.getImage(image).inspect())),
		);
		expect(imagesFound).to.deep.equal([false, true, true]);
	});

	it('should remove more than one image if necessary', async function () {
		this.timeout(600000);
		if (SKIP_GC_TEST) {
			return;
		}

		for (const image of IMAGES) {
			await pullAsync(docker, image);
		}
		// Get the size of the first image, so we can add one to it to remove
		// the next one in addition
		const { Size: size } = await docker.getImage(IMAGES[0]).inspect();
		await dockerStorage.garbageCollect(size + 1);
		const imagesFound = await Promise.all(
			IMAGES.map((image) => promiseToBool(docker.getImage(image).inspect())),
		);
		expect(imagesFound).to.deep.equal([false, false, true]);
	});

	it('should not consider images in use', async function () {
		this.timeout(600000);
		const containerName = 'dont-consider-images-in-use-test';
		if (SKIP_GC_TEST) {
			return;
		}

		try {
			await pullAsync(docker, IMAGES[0]);
			const container = await docker.createContainer({
				Image: IMAGES[0],
				Tty: true,
				Cmd: ['sh', '-c', 'while true; do echo test; sleep 1; done'],
				name: containerName,
				HostConfig: { AutoRemove: true },
			});
			await container.start();
			await dockerStorage.garbageCollect(1);
			const imageInspect = await promiseToBool(
				docker.getImage(IMAGES[0]).inspect(),
			);
			expect(imageInspect).to.be.true;
		} finally {
			await docker.getContainer(containerName).stop();
		}
	});

	it('should get daemon host disk usage', async function () {
		this.timeout(600000);
		const du = await dockerStorage.getDaemonFreeSpace();
		expect(du).to.be.an('object');
		expect(du).to.have.property('free').that.is.a('number');
		expect(du).to.have.property('used').that.is.a('number');
		expect(du).to.have.property('total').that.is.a('number');
	});

	it('should get the correct architecture for a remote host', async function () {
		const arch = (await dockerStorage
			// @ts-expect-error getDaemonArchitecture is private
			.getDaemonArchitecture()) as Promise<string>;
		expect(arch).to.be.a('string');
	});

	it('should set a base image to be used', async function () {
		// @ts-expect-error baseImagePromise is private
		const img = await (dockerStorage.baseImagePromise as Promise<string>);
		expect(img).to.be.a('string');
	});
});
