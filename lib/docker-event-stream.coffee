es = require 'event-stream'
JSONStream = require 'JSONStream'

IMAGE_EVENTS = [ 'delete', 'import', 'pull', 'push', 'tag', 'untag' ]

CONTAINER_EVENTS = [
	'attach',      'commit',  'copy',  'create',  'destroy',  'die',     'exec_create',
	'exec_start',  'export',  'kill',  'oom',     'pause',    'rename',  'resize',
	'restart',     'start',   'stop',  'top',     'unpause'
]

exports.parseEventStream = parseEventStream = ->
	layer_mtimes = {}

	es.pipeline(
		JSONStream.parse()
		es.mapSync ({ status, id, from, timeNano }) ->
			if status in IMAGE_EVENTS
				layer_mtimes[id] = timeNano
			else if status in CONTAINER_EVENTS
				layer_mtimes[from] = timeNano
			return layer_mtimes
	)

exports.dockerMtimeStream = (docker) ->
	docker.getEvents()
	.then (stream) ->
		es.pipeline(
			stream
			parseEventStream()
		)
