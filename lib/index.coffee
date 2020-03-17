Promise = require 'bluebird'
_ = require 'lodash'
{ DockerProgress } = require 'docker-progress'

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

getImagesToRemove = (tree, reclaimSpace) ->
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

class DockerGC
	setDocker: (hostObj) ->
		@currentMtimes = {}
		@hostObj = _.defaults({ Promise }, hostObj)
		@dockerProgress = new DockerProgress(@hostObj)
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

	removeImage: (image) ->
		if image.repoTags
			# Docker will complain if we delete by id an image referenced by more
			# than one repository
			Promise.each image.repoTags, (tag) =>
				console.log("GC: Removing image: #{tag} (#{image.id})")
				@docker.getImage(tag).remove(noprune: true)
		else
			console.log("GC: Removing image: #{image.id}")
			@docker.getImage(image.id).remove(noprune: true)

	garbageCollect: (reclaimSpace) ->
		dockerImageTree(@docker, @currentMtimes)
		.then (tree) ->
			getImagesToRemove(tree, reclaimSpace)
		.each (image) =>
			@removeImage(image)
			.tapCatch (e) ->
				console.log('GC: Failed to remove image: ', image)
				console.log(e)

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
