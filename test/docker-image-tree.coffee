Promise = require 'bluebird'
{ expect } = require 'chai'
fs = require 'fs'
tk = require 'timekeeper'
es = require 'event-stream'

{ parseEventStream } = require '../lib/docker-event-stream'
{ createTree } = require '../lib/docker-image-tree'

getLayerMtimes = () ->
	new Promise (resolve, reject) ->
		mtimes = null
		fs.createReadStream(__dirname + '/fixtures/docker-events.json')
		.pipe(parseEventStream())
		.on 'error', reject
		.pipe es.mapSync (data) ->
			mtimes = data
		.on 'end', -> resolve(mtimes)
		.on 'error', reject

describe 'createTree', ->
	it.skip 'should work with empty input', ->

	it 'should return a tree of images', ->
		images = require('./fixtures/docker-images.json')
		containers = require('./fixtures/docker-containers.json')
		getLayerMtimes()
		.then (mtimes) ->
			tk.freeze(Date.UTC(2016, 0, 1))
			tree = createTree(images, containers, mtimes)
			tk.reset()
			output = {
				"id": "0000000000000000000000000000000000000000000000000000000000000000",
				"size": 0,
				"repoTags": [],
				"mtime": 1451606400000,
				"isUsedByAContainer": false,
				"children": {
					"6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74": {
						"id": "6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74",
						"size": 125151141,
						"repoTags": [],
						"mtime": 1451606400000,
						"isUsedByAContainer": false,
						"children": {
							"e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc": {
								"id": "e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc",
								"size": 0,
								"repoTags": [
									"project1"
								],
								"mtime": 1451606400000,
								"isUsedByAContainer": false,
								"children": {
									"6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c": {
										"id": "6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c",
										"size": 330389,
										"repoTags": [
											"project2"
										],
										"mtime": 1448576073000,
										"isUsedByAContainer": false,
										"children": {
											"80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea": {
												"id": "80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea",
												"size": 98872,
												"repoTags": [],
												"mtime": 1451606400000,
												"isUsedByAContainer": false,
												"children": {}
											}
										}
									}
								}
							}
						}
					},
					"902b87aaaec929e80541486828959f14fa061f529ad7f37ab300d4ef9f3a0dbf": {
						"id": "902b87aaaec929e80541486828959f14fa061f529ad7f37ab300d4ef9f3a0dbf",
						"size": 125151141,
						"repoTags": [],
						"mtime": 1451606400000,
						"isUsedByAContainer": false,
						"children": {
							"9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e": {
								"id": "9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e",
								"size": 0,
								"repoTags": [
									"resin/project3"
								],
								"mtime": 1448576073000,
								"isUsedByAContainer": false,
								"children": {}
							}
						}
					},
					"5b0d59026729b68570d99bc4f3f7c31a2e4f2a5736435641565d93e7c25bd2c3": {
						"id": "5b0d59026729b68570d99bc4f3f7c31a2e4f2a5736435641565d93e7c25bd2c3",
						"size": 125151141,
						"repoTags": [
							"busybox:latest"
						],
						"mtime": 1448576072000,
						"isUsedByAContainer": true,
						"children": {},
					}
				}
			}
			expect(tree).to.deep.equal(output)
