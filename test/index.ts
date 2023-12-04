import type Docker from 'dockerode';
import Bluebird from 'bluebird';
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

const promiseToBool = (p: Promise<unknown>): Promise<boolean> =>
	p.then(() => true).catch(() => false);

const pullAsync = function (docker: Docker, tag: string) {
	console.log(`[TEST] Pulling ${tag}`);
	return docker.pull(tag).then(
		(stream) =>
			new Promise(function (resolve, reject) {
				stream.resume();
				stream.once('error', reject);
				stream.once('end', resolve);
			}),
	);
};

// This test case is a little weird, it requires that no other images are present on
// the system to ensure that the correct one is being removed. Because of this, you
// can use the SKIP_GC_TEST env var to inform the test suite not to run this test
describe('Garbage collection', function () {
	let dockerStorage: DockerGC;
	let docker: Docker;
	beforeEach(function () {
		dockerStorage = new DockerGC();
		// Use either local or CI docker
		return Bluebird.join(
			getDocker({
				socketPath: '/tmp/dind/docker.sock',
			}),
			dockerStorage.setDocker({
				socketPath: '/tmp/dind/docker.sock',
			}),
			($docker) => {
				docker = $docker;
				return dockerStorage.setupMtimeStream();
			},
		);
	});

	afterEach(function () {
		console.log('[afterEach] Cleaning up...');
		return IMAGES.concat(NONE_TAG_IMAGES).map((image) =>
			docker
				.getImage(image)
				.remove()
				.catch(function () {
					// Ignore
				}),
		);
	});

	it('should remove a image by tag', function () {
		this.timeout(600000);

		return pullAsync(docker, IMAGES[0])
			.then(() => docker.getImage(IMAGES[0]).inspect())
			.then(() => dockerStorage.garbageCollect(1))
			.then(() => promiseToBool(docker.getImage(IMAGES[0]).inspect()))
			.then((imageFound) => expect(imageFound).to.be.false);
	});

	it('should remove a image by digest if its tag == none', function () {
		this.timeout(600000);

		return pullAsync(docker, NONE_TAG_IMAGES[0])
			.then(() => docker.getImage(NONE_TAG_IMAGES[0]).inspect())
			.then(() => dockerStorage.garbageCollect(1))
			.then(() => promiseToBool(docker.getImage(NONE_TAG_IMAGES[0]).inspect()))
			.then((imageFound) => expect(imageFound).to.be.false);
	});

	it('should remove a image with tag == none even if it is in several repos', function () {
		this.timeout(600000);

		return Bluebird.each(NONE_TAG_IMAGES, (image) => pullAsync(docker, image))
			.then(() => docker.getImage(NONE_TAG_IMAGES[0]).inspect())
			.then(() => dockerStorage.garbageCollect(1))
			.then(() =>
				Bluebird.map(NONE_TAG_IMAGES, (image) =>
					promiseToBool(docker.getImage(image).inspect()),
				),
			)
			.then((imagesFound) => expect(imagesFound).to.deep.equal([false, false]));
	});

	it('should remove all tags of an image', function () {
		this.timeout(600000);
		if (SKIP_GC_TEST) {
			return Promise.resolve();
		}

		// first pull some images, so we know in which order they are referenced
		return pullAsync(docker, IMAGES[0])
			.then(() =>
				docker.getImage(IMAGES[0]).tag({ repo: 'some-repo', tag: 'some-tag' }),
			)
			.then(() => {
				return dockerStorage.garbageCollect(1);
			})
			.then(() => promiseToBool(docker.getImage(IMAGES[0]).inspect()))
			.then((imagesFound) => expect(imagesFound).to.be.false);
	});

	it('should remove the LRU image', function () {
		this.timeout(600000);
		if (SKIP_GC_TEST) {
			return Promise.resolve();
		}

		// first pull some images, so we know in which order they are referenced
		return pullAsync(docker, IMAGES[0])
			.then(() =>
				docker.getImage(IMAGES[0]).tag({ repo: 'some-repo', tag: 'some-tag' }),
			)
			.then(() =>
				Bluebird.each(IMAGES.slice(1), (image) => pullAsync(docker, image)),
			)
			.then(() => {
				// Attempt to remove a single byte, which will remove the LRU image,
				// which should be alpine
				return dockerStorage.garbageCollect(1);
			})
			.then(() =>
				Bluebird.map(IMAGES, (image) =>
					promiseToBool(docker.getImage(image).inspect()),
				),
			)
			.then((imagesFound) =>
				expect(imagesFound).to.deep.equal([false, true, true]),
			);
	});

	it('should remove more than one image if necessary', function () {
		this.timeout(600000);
		if (SKIP_GC_TEST) {
			return Promise.resolve();
		}

		return Bluebird.each(IMAGES, (image) => pullAsync(docker, image))
			.then(() =>
				// Get the size of the first image, so we can add one to it to remove
				// the next one in addition
				docker
					.getImage(IMAGES[0])
					.inspect()
					.then((i) => i.Size),
			)
			.then((size) => {
				return dockerStorage.garbageCollect(size + 1);
			})
			.then(() =>
				Bluebird.map(IMAGES, (image) =>
					promiseToBool(docker.getImage(image).inspect()),
				),
			)
			.then((imagesFound) =>
				expect(imagesFound).to.deep.equal([false, false, true]),
			);
	});

	it('should not consider images in use', function () {
		this.timeout(600000);
		const containerName = 'dont-consider-images-in-use-test';
		if (SKIP_GC_TEST) {
			return Promise.resolve();
		}

		return pullAsync(docker, IMAGES[0])
			.then(() =>
				docker.createContainer({
					Image: IMAGES[0],
					Tty: true,
					Cmd: ['sh', '-c', 'while true; do echo test; sleep 1; done'],
					name: containerName,
					HostConfig: { AutoRemove: true },
				}),
			)
			.then((container) => container.start())
			.then(() => {
				return dockerStorage.garbageCollect(1);
			})
			.then(() => promiseToBool(docker.getImage(IMAGES[0]).inspect()))
			.then((imageInspect) => expect(imageInspect).to.be.true)
			.finally(() => docker.getContainer(containerName).stop());
	});

	it('should get daemon host disk usage', function () {
		this.timeout(600000);
		return dockerStorage.getDaemonFreeSpace().then(function (du) {
			expect(du).to.be.an('object');
			expect(du).to.have.property('free').that.is.a('number');
			expect(du).to.have.property('used').that.is.a('number');
			expect(du).to.have.property('total').that.is.a('number');
		});
	});

	it('should get the correct architecture for a remote host', function () {
		return (
			(
				dockerStorage
					// @ts-expect-error getDaemonArchitecture is private
					.getDaemonArchitecture() as Promise<string>
			).then((arch) => expect(arch).to.be.a('string'))
		);
	});

	it('should set a base image to be used', function () {
		// @ts-expect-error baseImagePromise is private
		return (dockerStorage.baseImagePromise as Promise<string>).then((img) =>
			expect(img).to.be.a('string'),
		);
	});
});
