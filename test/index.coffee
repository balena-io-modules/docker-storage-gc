Promise = require 'bluebird'
{ expect } = require 'chai'

DockerGC = require('../lib/index')
dockerUtils = require('../lib/docker.coffee')

SKIP_GC_TEST = process.env.SKIP_GC_TEST == '1' || false
IMAGES = [ 'alpine:3.1', 'debian:squeeze', 'ubuntu:lucid' ]

# TODO: Move it to a proper repo
# Same image (same id), different repo, different digest
NONE_TAG_IMAGES = ['hello-world@sha256:8e3114318a995a1ee497790535e7b88365222a21771ae7e53687ad76563e8e76',
	'balenaplayground/hello-world@sha256:90659bf80b44ce6be8234e6ff90a1ac34acbeb826903b02cfa0da11c82cbc042']

promiseToBool = (p) ->
	p.return(true).catchReturn(false)

pullAsync = (docker, tag) ->
	console.log("[TEST] Pulling #{tag}")
	docker.pull(tag)
	.then (stream) ->
		new Promise (resolve, reject) ->
			stream.resume()
			stream.once('error', reject)
			stream.once('end', resolve)

# This test case is a little weird, it requires that no other images are present on
# the system to ensure that the correct one is being removed. Because of this, you
# can use the SKIP_GC_TEST env var to inform the test suite not to run this test
describe 'Garbage collection', ->
	beforeEach ->
		@dockerStorage = new DockerGC()
		# Use either local or CI docker
		Promise.join(
			dockerUtils.getDocker({})
			@dockerStorage.setDocker({})
			(docker) =>
				@dockerStorage.setupMtimeStream()
				@docker = docker
		)

	afterEach ->
		docker = @docker
		console.log('[afterEach] Cleaning up...')
		for image in IMAGES.concat(NONE_TAG_IMAGES)
			docker.getImage(image).remove()
			.catch ->

	it 'should remove a image by tag', ->
		this.timeout(600000)
		docker = @docker
		dockerStorage = @dockerStorage

		pullAsync(docker, IMAGES[0])
		.then ->
			docker.getImage(IMAGES[0]).inspect()
		.then ->
			dockerStorage.garbageCollect(1)
		.then ->
			promiseToBool(docker.getImage(NONE_TAG_IMAGES[0]).inspect())
		.then (image_found) ->
			expect(image_found).to.be.false

	it 'should remove a image by digest if its tag == none', ->
		this.timeout(600000)
		docker = @docker
		dockerStorage = @dockerStorage

		pullAsync(docker, NONE_TAG_IMAGES[0])
		.then ->
			docker.getImage(NONE_TAG_IMAGES[0])	.inspect()
		.then ->
			dockerStorage.garbageCollect(1)
		.then ->
			promiseToBool(docker.getImage(NONE_TAG_IMAGES[0]).inspect())
		.then (image_found) ->
			expect(image_found).to.be.false

	it 'should remove a image with tag == none even if it is in several repos', ->
		this.timeout(600000)
		docker = @docker
		dockerStorage = @dockerStorage

		Promise.each NONE_TAG_IMAGES, (image) ->
			pullAsync(docker, image)
		.then ->
			docker.getImage(NONE_TAG_IMAGES[0])	.inspect()
		.then ->
			dockerStorage.garbageCollect(1)
		.then ->
			Promise.map NONE_TAG_IMAGES, (image) ->
				promiseToBool(docker.getImage(image).inspect())
		.then (imagesFound) ->
			expect(imagesFound).to.deep.equal([false, false])


	it 'should remove all tags of an image', ->
		this.timeout(600000)
		return Promise.resolve() if SKIP_GC_TEST

		docker = @docker

		# first pull some images, so we know in which order they are referenced
		pullAsync(docker, IMAGES[0])
		.then ->
			docker.getImage(IMAGES[0]).tag(repo: 'some-repo', tag: 'some-tag')
		.then =>
			@dockerStorage.garbageCollect(1)
		.then ->
			promiseToBool(docker.getImage(IMAGES[0]).inspect())
		.then (imagesFound) ->
			expect(imagesFound).to.be.false


	it 'should remove the LRU image', ->
		this.timeout(600000)
		return Promise.resolve() if SKIP_GC_TEST

		docker = @docker

		# first pull some images, so we know in which order they are referenced
		pullAsync(docker, IMAGES[0])
		.then ->
			docker.getImage(IMAGES[0]).tag(repo: 'some-repo', tag: 'some-tag')
		.then ->
			Promise.each IMAGES.slice(1), (image) ->
				pullAsync(docker, image)
		.then =>
			# Attempt to remove a single byte, which will remove the LRU image,
			# which should be alpine
			@dockerStorage.garbageCollect(1)
		.then ->
			Promise.map IMAGES, (image) ->
				promiseToBool(docker.getImage(image).inspect())
		.then (imagesFound) ->
			expect(imagesFound).to.deep.equal([false, true, true])

	it 'should remove more than one image if necessary', ->
		this.timeout(600000)
		return Promise.resolve() if SKIP_GC_TEST

		docker = @docker

		Promise.each IMAGES, (image) ->
			pullAsync(docker, image)
		.then ->
			# Get the size of the first image, so we can add one to it to remove
			# the next one in addition
			docker.getImage(IMAGES[0]).inspect().get('Size')
		.then (size) =>
			@dockerStorage.garbageCollect(size + 1)
		.then ->
			Promise.map IMAGES, (image) ->
				promiseToBool(docker.getImage(image).inspect())
		.then (imagesFound) ->
			expect(imagesFound).to.deep.equal([false, false, true])

	it 'should get daemon host disk usage', ->
		this.timeout(600000)
		@dockerStorage.getDaemonFreeSpace()
		.then (du) ->
			expect(du).to.be.an('object')
			expect(du).to.have.property('free').that.is.a('number')
			expect(du).to.have.property('used').that.is.a('number')
			expect(du).to.have.property('total').that.is.a('number')

	it 'should get the correct architecture for a remote host', ->
		@dockerStorage.getDaemonArchitecture()
		.then (arch) ->
			expect(arch).to.be.a('string')

	it 'should set a base image to be used', ->
		@dockerStorage.baseImagePromise.then (img) ->
			expect(img).to.be.a('string')
