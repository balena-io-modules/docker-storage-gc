es = require 'event-stream'
Docker = require 'dockerode'
Promise = require 'bluebird'
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
		es.mapSync ({status, id, from, time}) ->
			if status in IMAGE_EVENTS
				layer_mtimes[id] = time * 1000
			else if status in CONTAINER_EVENTS
				layer_mtimes[from] = time * 1000
			return layer_mtimes
	)


docker = new Docker(socketPath: '/var/run/docker.sock')
docker = Promise.promisifyAll(docker)

exports.dockerMtimeStream = dockerMtimeStream = ->
	docker.getEventsAsync()
	.then (stream) ->
		es.pipeline(
			stream
			parseEventStream()
		)
