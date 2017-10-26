Promise = require 'bluebird'
es = require 'event-stream'
_ = require 'lodash'

{ dockerMtimeStream } = require './docker-event-stream'
{ dockerImageTree, annotateTree } = require './docker-image-tree'
{ createCompare, lruSort } = require './lru'
dockerUtils = require './docker'

class DockerGC
	setDocker: (hostObj) ->
		@currentMtimes = {}
		@hostObj = hostObj
		dockerUtils.getDocker(hostObj)
		.then (docker) =>
			@docker = docker

	setupMtimeStream: () ->
		dockerMtimeStream(@docker)
		.then (stream) =>
			stream
			.on 'data', (layer_mtimes) =>
				@currentMtimes = layer_mtimes

	garbageCollect: (reclaimSpace) ->
		dockerImageTree(@docker)
		.then(annotateTree.bind(null, @currentMtimes))
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

module.exports = DockerGC
