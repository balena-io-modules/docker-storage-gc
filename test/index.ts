import type Docker from 'dockerode';
import { expect } from 'chai';
import DockerGC from '../build/index';
import { DOCKER_OPTS, docker } from './lib/common';

const SKIP_GC_TEST = process.env.SKIP_GC_TEST === '1' || false;
const IMAGES = ['alpine:3.18', 'debian:bookworm-slim', 'ubuntu:22.04'];

// Per-platform manifest digests shared by hello-world and <arch>/hello-world.
// These are content-addressed and immutable — if they stop resolving to the
// same image ID, something fundamental changed upstream and the test should fail.
const NONE_TAG_DIGESTS: Record<string, string> = {
	amd64:
		'sha256:d1a8d0a4eeb63aff09f5f34d4d80505e0ba81905f36158cc3970d8e07179e59e',
	arm64:
		'sha256:5099b89d7666cc2186cad769ddc262ddc7c335b33f5fe79f9ffe50a01282b23e',
};

const promiseToBool = async (p: Promise<unknown>): Promise<boolean> => {
	try {
		await p;
		return true;
	} catch {
		return false;
	}
};

const pullAsync = async function (d: Docker, tag: string) {
	console.log(`[TEST] Pulling ${tag}`);
	const stream = await d.pull(tag);
	return await new Promise(function (resolve, reject) {
		stream.resume();
		stream.once('error', reject);
		stream.once('end', resolve);
	});
};

const removeAsync = async function (d: Docker, images: string[]) {
	await Promise.all(
		images.map(async (image) => {
			try {
				await d.getImage(image).remove({ force: true });
			} catch (err: any) {
				if (err.statusCode !== 404 && err.statusCode !== 409) {
					throw err;
				}
			}
		}),
	);
};

// This test case is a little weird, it requires that no other images are present on
// the system to ensure that the correct one is being removed. Because of this, you
// can use the SKIP_GC_TEST env var to inform the test suite not to run this test
describe('Garbage collection', function () {
	let dockerStorage: DockerGC;

	let NONE_TAG_IMAGES: string[];

	before(async function () {
		this.timeout(120000);

		const { Arch } = await docker.version();
		const digest = NONE_TAG_DIGESTS[Arch];
		if (digest == null) {
			throw new Error(`No known hello-world digest for architecture: ${Arch}`);
		}

		const archRepo =
			Arch === 'arm64' ? 'arm64v8' : Arch === 'amd64' ? 'amd64' : Arch;
		NONE_TAG_IMAGES = [
			`hello-world@${digest}`,
			`${archRepo}/hello-world@${digest}`,
		];

		// Pull both refs and verify they resolve to the same image ID
		await pullAsync(docker, NONE_TAG_IMAGES[0]);
		await pullAsync(docker, NONE_TAG_IMAGES[1]);
		const hwInspect = await docker.getImage(NONE_TAG_IMAGES[0]).inspect();
		const archInspect = await docker.getImage(NONE_TAG_IMAGES[1]).inspect();

		if (hwInspect.Id !== archInspect.Id) {
			throw new Error(
				`hello-world and ${archRepo}/hello-world have different image IDs: ` +
					`${hwInspect.Id} !== ${archInspect.Id}`,
			);
		}

		// Clean up tag-pulled images so tests start fresh
		await removeAsync(docker, NONE_TAG_IMAGES);
	});

	beforeEach(async function () {
		dockerStorage = new DockerGC();
		await dockerStorage.setDocker(DOCKER_OPTS);
		await dockerStorage.setupMtimeStream();
	});

	afterEach(async function () {
		await removeAsync(docker, IMAGES.concat(NONE_TAG_IMAGES));
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
