Promise = require 'bluebird'
es = require 'event-stream'
_ = require 'lodash'
{ DockerProgress } = require 'docker-progress'

{ dockerMtimeStream } = require './docker-event-stream'
{ dockerImageTree } = require './docker-image-tree'
{ createCompare, lruSort } = require './lru'
dockerUtils = require './docker'

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

	setupMtimeStream: () ->
		dockerMtimeStream(@docker)
		.then (stream) =>
			stream
			.on 'data', (layer_mtimes) =>
				@currentMtimes = layer_mtimes

	garbageCollect: (reclaimSpace) ->
		dockerImageTree(@docker, @currentMtimes)
		.then (tree) ->
			lruSort(tree, createCompare(1, 0))
		.then (candidates) ->
			# Remove candidates until we reach `reclaimSpace` bytes
			# Candidates is a list of images, with the least recently used
			# first in the list

			# Decide on the images to remove
			size = 0
			return _.takeWhile candidates, (image) ->
				return false if size >= reclaimSpace
				size += image.size
				return true
		.map (image) =>
			# Request deletion of each image
			console.log("GC: Removing image: #{image.repoTags[0]}")
			@docker.getImage(image.id).remove()
			.return(true)
			.catch (e) ->
				# TODO: If an image fails to be removed, this means that the total space
				# removed will actually be less than the requested amount. We need to
				# take into account if an image fails to be removed, and either select a
				# new one or retry
				console.log('GC: Failed to remove image: ', image)
				console.log(e)
				return false
		.then (results) ->
			console.log('GC: Done.')
			return _.every(results)

	getDaemonFreeSpace: () ->
		@baseImagePromise.tap (baseImage) =>
			# Ensure the image is available (if it is this is essentially a no-op)
			@dockerProgress.pull(baseImage, _.noop)
		.then (baseImage) =>
			@docker.run(baseImage, [ '/bin/df', '-B', '1', '/' ])
			.then (container) ->
				container.logs(stdout: 1)
			.then (logs) ->
				new Promise (resolve, reject) ->
					logStr = ''
					logs
					.on('data', (data) -> logStr += data.toString('utf-8'))
					.on('end', () -> resolve(logStr))
					.on('error', reject)
			.then (spaceStr) ->
				# First split the lines, as we're only interested in the second one
				lines = spaceStr.trim().split(/\r?\n/)
				if lines.length isnt 2
					throw new Error('Coult not parse df output')

				parts = lines[1].split(/\s+/)
				total = parseInt(parts[1])
				used = parseInt(parts[2])
				free = parseInt(parts[3])
				return {
					used,
					total,
					free
				}

	getDaemonArchitecture: () ->
		@docker.version()
		.get('Arch')

module.exports = DockerGC
