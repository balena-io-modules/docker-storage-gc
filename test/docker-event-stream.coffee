Promise = require 'bluebird'
{ expect } = require 'chai'
fs = require 'fs'
es = require 'event-stream'

{ parseEventStream } = require '../lib/docker-event-stream'

describe 'parseEventStream', ->
	it.skip 'should work with empty stream', ->

	it 'should return updated mtimes', ->
		new Promise (resolve, reject) ->
			mtimes = null

			fs.createReadStream(__dirname + '/fixtures/docker-events.json')
			.pipe(parseEventStream())
			.on 'error', reject
			.pipe es.mapSync (data) ->
				mtimes = data
			.on 'end', -> resolve(mtimes)
			.on 'error', reject
		.then (data) ->
			expect(data).to.have.property('busybox:latest').that.equals(1448576072937294800)
			expect(data).to.have.property('6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c').that.equals(1448576073085559800)
			expect(data).to.have.property('9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e').that.equals(1448576073203895800)
