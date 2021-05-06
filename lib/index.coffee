Promise = require 'bluebird'
_ = require 'lodash'
{ EventEmitter } = require 'eventemitter3'

{ DockerProgress } = require 'docker-progress'
Docker = require 'dockerode'

{ dockerMtimeStream } = require './docker-event-stream'
{ dockerImageTree } = require './docker-image-tree'
dockerUtils = require './docker'

getUnusedTreeLeafs = (tree, result = []) ->
	if not tree.removed
		children = _(tree.children)
		.values()
		.filter(_.negate(_.property('removed')))
		.value()
		if children.length == 0 and not tree.isUsedByAContainer
			result.push(tree)
		else
			for child in children
				getUnusedTreeLeafs(child, result)
	return result

getImagesToRemove = (tree, reclaimSpace, metrics) ->
	# Removes the oldest, largest leafs first.
	# This should avoid trying to remove images with children.
	tree = _.clone(tree)
	result = []
	size = 0
	while size < reclaimSpace
		leafs = _.orderBy(
			getUnusedTreeLeafs(tree)
			[ 'mtime', 'size' ]
			[ 'asc', 'desc' ]
		)
		if leafs.length == 0
			break
		leaf = leafs[0]
		if leaf != tree
			# don't remove the tree root
			result.push(leaf)
			size += leaf.size
		leaf.removed = true

	metrics.emit('numberImagesToRemove', result.length)
	return result

streamToString = (stream) ->
	new Promise (resolve, reject) ->
		chunks = []
		stream
		.on('error', reject)
		.on 'data', (chunk) ->
			chunks.push(chunk)
		.on 'end', ->
			resolve(Buffer.concat(chunks).toString())

recordGcRunTime = (t0, metrics) ->
	dt = process.hrtime(t0)
	duration = dt[0] * 1000 + dt[1] / 1e6
	metrics.emit('gcRunTime', duration)

class DockerGC

	constructor: ->
		@metrics = new EventEmitter()
		@host = 'unknown'

	setHostname: (hostname) ->
		@host = hostname

	setDocker: (hostObj) ->
		@currentMtimes = {}
		@hostObj = _.defaults({ Promise }, hostObj)
		@dockerProgress = new DockerProgress({ docker: new Docker(@hostObj) })
		dockerUtils.getDocker(@hostObj)
		.then (@docker) =>
			# Docker info can take a while so do it here,
			# and don't wait on the results
			@baseImagePromise = @getDaemonArchitecture()
			.then (arch) ->
				return switch arch
					when 'arm64' then 'arm64v8/alpine:3.6'
					when 'amd64' then 'alpine:3.6'
					else
						throw new Error('Could not detect architecture of remote host')

	setupMtimeStream: ->
		dockerMtimeStream(@docker)
		.then (stream) =>
			stream
			.on 'data', (layer_mtimes) =>
				@currentMtimes = layer_mtimes

	removeImage: (image) =>
		return this.tryRemoveImageBy(image, image.repoTags, 'tag') ||
					 this.tryRemoveImageBy(image, image.repoDigests, 'digest') ||
					 this.tryRemoveImageBy(image, [image.id], 'id')

	tryRemoveImageBy: (image, attributes, removalType) =>
		if attributes? and attributes.length > 0
			Promise.each attributes, (attribute) =>
				console.log("[GC (#{@host}] Removing image : #{attribute} (id: #{image.id})")
				@docker.getImage(attribute).remove(noprune: true)
				.then =>
					@metrics.emit('imageRemoved', removalType)

	garbageCollect: (reclaimSpace, attemptAll = false) =>
		err = null
		startTime = process.hrtime()
		@metrics.emit('spaceReclaimed', reclaimSpace)
		dockerImageTree(@docker, @currentMtimes)
		.then (tree) =>
			getImagesToRemove(tree, reclaimSpace, @metrics)
		.each (image) =>
			@removeImage(image)
			.catch (e) =>
				@metrics.emit('imageRemovalError', e.statusCode)
				console.log("[GC #{@host}]: Failed to remove image: ", image)
				console.log(e)
				if attemptAll
					err ?= e
				else
					recordGcRunTime(startTime, @metrics)
					throw e
		.then =>
			recordGcRunTime(startTime, @metrics)
			if err?
				throw err

	getOutput: (image, command) ->
		Promise.using @runDisposer(image, command), (container) ->
			container.logs(stdout: true, follow: true)
			.then (logs) ->
				streamToString(logs)

	runDisposer: (image, command) ->
		@docker.run(image, command)
		.disposer (container) ->
			container.wait()
			.then ->
				container.remove()

	getDaemonFreeSpace: ->
		@baseImagePromise.tap (baseImage) =>
			# Ensure the image is available (if it is this is essentially a no-op)
			@dockerProgress.pull(baseImage, _.noop)
		.then (baseImage) =>
			@getOutput(baseImage, [ '/bin/df', '-B', '1', '/' ])
		.then (spaceStr) ->
			# First split the lines, as we're only interested in the second one
			lines = spaceStr.trim().split(/\r?\n/)
			if lines.length isnt 2
				throw new Error('Coult not parse df output')

			parts = lines[1].split(/\s+/)
			total = parseInt(parts[1])
			used = parseInt(parts[2])
			free = parseInt(parts[3])
			return { used, total, free }

	getDaemonArchitecture: ->
		@docker.version()
		.get('Arch')

module.exports = DockerGC
