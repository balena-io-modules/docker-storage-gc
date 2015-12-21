Promise = require 'bluebird'
es = require 'event-stream'

{ dockerMtimeStream } = require './docker-event-stream'
{ dockerImageTree, annotateTree } = require './docker-image-stream'
{ createCompare, lruSort } = require './lru'

current_mtimes = {}

dockerMtimeStream()
.then (stream) ->
	stream
	.on 'data', (layer_mtimes) ->
		current_mtimes = layer_mtimes

garbageCollect = (reclaimSpace) ->
	dokcerImageTree()
	.then(annotateTree.bine(null, current_mtimes))
	.then (tree) ->
		lruSort(tree, createCompare(1, 0))
	.then (candidates) ->
		# Remove candidates until we reach `reclaimSpace` bytes
		console.log('foobar')
