Promise = require 'bluebird'
es = require 'event-stream'
JSONStream = require 'JSONStream'

IMAGE_EVENTS = [ 'delete', 'import', 'pull', 'push', 'tag', 'untag' ]

CONTAINER_EVENTS = [
	'attach',      'commit',  'copy',  'create',  'destroy',  'die',     'exec_create',
	'exec_start',  'export',  'kill',  'oom',     'pause',    'rename',  'resize',
	'restart',     'start',   'stop',  'top',     'unpause'
]

exports.parseEventStream = parseEventStream = (docker) ->
	docker.listImages(all: true).then((images) ->
		layer_mtimes = {}
		# Start off by setting all current images to an mtime of 0 as we've never seen them used
		# If we've never seen the layer used then it's likely created before we started
		# listening and so set the last used time to 0 as we know it should be older than
		# anything we've seen
		for image in images
			layer_mtimes[image.id] = 0

		return es.pipeline(
			JSONStream.parse()
			es.mapSync ({ status, id, from, timeNano }) ->
				if status in IMAGE_EVENTS
					layer_mtimes[id] = timeNano
				else if status in CONTAINER_EVENTS
					layer_mtimes[from] = timeNano
				return layer_mtimes
		)
	)

exports.dockerMtimeStream = (docker) ->
	Promise.join(
		docker.getEvents()
		parseEventStream(docker)
		(stream, streamParser) ->
			es.pipeline(
				stream
				streamParser
			)
	)
