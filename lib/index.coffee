Promise = require 'bluebird'
es = require 'event-stream'

{ dockerMtimeStream } = require './docker-event-stream'
{ dockerImageTree, annotateTree } = require './docker-image-tree'
{ lruSort } = require './lru'

current_mtimes = {}

dockerMtimeStream()
.then (stream) ->
	stream
	.on 'data', (layer_mtimes) ->
		current_mtimes = layer_mtimes
		garbageCollect(50)

garbageCollect = (reclaimSpace) ->
	dockerImageTree()
	.then(annotateTree.bind(null, current_mtimes))
	.then(lruSort)
	.then (candidates) ->
		# Remove candidates until we reach `reclaimSpace` bytes
		console.log(JSON.stringify candidates, null, ' ')
