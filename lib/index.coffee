Promise = require 'bluebird'
es = require 'event-stream'
_ = require 'lodash'

{ dockerMtimeStream } = require './docker-event-stream'
{ getDocker, dockerImageTree, annotateTree } = require './docker-image-tree'
{ lruSort } = require './lru'

current_mtimes = {}

dockerMtimeStream()
.then (stream) ->
	stream
	.on 'data', (layer_mtimes) ->
		current_mtimes = layer_mtimes

garbageCollect = (reclaimSpace) ->
	dockerImageTree()
	.then(annotateTree.bind(null, current_mtimes))
	.then(lruSort)
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
	.then (images) ->
		# Request deletion of each image
		Promise.map images, (image) ->
			console.log("Removing image: #{image.repoTags[0]}")
			getDocker().getImage(image.id).removeAsync()
		.then ->
			console.log('Done.')

