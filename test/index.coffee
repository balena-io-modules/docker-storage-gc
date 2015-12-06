Promise = require 'bluebird'
{ expect } = require 'chai'
_ = require 'lodash'
fs = require 'fs'
tk = require 'timekeeper'
es = require 'event-stream'

{ createNode, createTree, parseEventStream, annotateTree, merge, lruSort } = require '../lib/index'

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
			expect(data).to.have.property('busybox:latest').that.equals(1448576072000)
			expect(data).to.have.property('6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c').that.equals(1448576073000)
			expect(data).to.have.property('9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e').that.equals(1448576073000)

describe 'createTree', ->
	it.skip 'should work with empty input', ->

	it 'should return a tree of images', ->
		input = require('./fixtures/docker-images.json')
		tree = createTree(input)
		output = {
			"id": "0000000000000000000000000000000000000000000000000000000000000000",
			"size": 0,
			"repoTags": [],
			"mtime": null,
			"children": {
				"6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74": {
					"id": "6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74",
					"size": 125151141,
					"repoTags": [],
					"mtime": null,
					"children": {
						"e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc": {
							"id": "e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc",
							"size": 0,
							"repoTags": ['project1'],
							"mtime": null,
							"children": {
								"6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c": {
									"id": "6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c",
									"size": 330389,
									"repoTags": ['project2'],
									"mtime": null,
									"children": {
										"80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea": {
											"id": "80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea",
											"size": 98872,
											"repoTags": [],
											"mtime": null,
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
					"mtime": null,
					"children": {
						"9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e": {
							"id": "9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e",
							"size": 0,
							"repoTags": ['resin/project3'],
							"mtime": null,
							"children": {}
						}
					}
				}
			}
		}
		expect(tree).to.deep.equal(output)

describe 'annotateTree', ->
	it 'should annotate a tree with mtimes', ->
		input = require('./fixtures/docker-images.json')
		tree = createTree(input)

		new Promise (resolve, reject) ->
			mtimes = null

			fs.createReadStream(__dirname + '/fixtures/docker-events.json')
			.pipe(parseEventStream())
			.on 'error', reject
			.pipe es.mapSync (data) ->
				mtimes = data
			.on 'end', -> resolve(mtimes)
			.on 'error', reject
		.then (layer_mtimes) ->
			tk.freeze(Date.UTC(2016, 0, 1))
			annTree = annotateTree(layer_mtimes, tree)
			tk.reset()

			output = {
				"id": "0000000000000000000000000000000000000000000000000000000000000000",
				"size": 0,
				"repoTags": [],
				"mtime": 1451606400000,
				"children": {
					"6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74": {
						"id": "6d15899cef812e2876b9d5d43d4cd863eda7b278f7b52d00975f6a9a8e817c74",
						"size": 125151141,
						"repoTags": [],
						"mtime": 1451606400000,
						"children": {
							"e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc": {
								"id": "e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc",
								"size": 0,
								"repoTags": [
									"project1"
								],
								"mtime": 1451606400000,
								"children": {
									"6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c": {
										"id": "6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c",
										"size": 330389,
										"repoTags": [
											"project2"
										],
										"mtime": 1448576073000,
										"children": {
											"80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea": {
												"id": "80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea",
												"size": 98872,
												"repoTags": [],
												"mtime": 1451606400000,
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
						"children": {
							"9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e": {
								"id": "9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e",
								"size": 0,
								"repoTags": [
									"resin/project3"
								],
								"mtime": 1448576073000,
								"children": {}
							}
						}
					}
				}
			}

			expect(annTree).to.deep.equal(output)

describe 'merge', ->
	it 'should merge []', ->
		expect(merge([])).to.deep.equal([])
	it 'should merge [[],[],...]', ->
		expect(merge([ [], [] ])).to.deep.equal([])
	it 'should merge [[a],[],[],...]', ->
		expect(merge([ [0],[],[] ])).to.deep.equal([0])
	it 'should merge arrays of sorted numbers', ->
		expect(merge([ [1,3,5],[2,4,6] ])).to.deep.equal([1,2,3,4,5,6])
	it 'should merge unsorted numbers in the order they were given', ->
		expect(merge([ [5,3,1],[4,6,2] ])).to.deep.equal([4,5,3,1,6,2])

describe 'lruSort', ->
	it 'should sort a single node', ->
		a = createNode('a')

		ret_a = _.clone(a)
		delete ret_a.children

		expect(lruSort(a)).to.deep.equal([ret_a])
	it 'should sort a root node with two children', ->
		return
		a = createNode('a')
		a.size = 2
		a.mtime = 2

		b = createNode('b')
		b.size = 7
		b.mtime = 3

		c = createNode('c')
		c.size = 10
		c.mtime = 5

		a.children['b'] = b
		a.children['c'] = c

		ret_b = _.clone(b)
		delete ret_b.children

		ret_c = _.clone(c)
		ret_c.size += a.size
		delete ret_c.children

		ret = lruSort(a)
		console.log(ret)
		expect(ret).to.deep.equal([ret_b, ret_c])

	it 'should sort a real tree with multiple tags', ->
		input = require('./fixtures/docker-images.json')
		tree = createTree(input)

		new Promise (resolve, reject) ->
			mtimes = null

			fs.createReadStream(__dirname + '/fixtures/docker-events.json')
			.pipe(parseEventStream())
			.on 'error', reject
			.pipe es.mapSync (data) ->
				mtimes = data
			.on 'end', -> resolve(mtimes)
			.on 'error', reject
		.then (layer_mtimes) ->
			tk.freeze(Date.UTC(2016, 0, 1))
			annTree = annotateTree(layer_mtimes, tree)
			tk.reset()

			ret = lruSort(annTree)
			output = [
				{
					"id": "9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e",
					"repoTags": [
						"resin/project3"
					],
					"size": 125151141,
					"mtime": 1448576073000
				},
				{
					"id": "80dc79d29cd8618e678da508fc32f7289e6f72defb534f3f287731b1f8b355ea",
					"repoTags": [],
					"size": 98872,
					"mtime": 1451606400000
				},
				{
					"id": "6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c",
					"repoTags": [
						"project2"
					],
					"size": 330389,
					"mtime": 1448576073000
				},
				{
					"id": "e53bd4df04f86919156c4510cdc6e6c9491ec8ec226381d36aca573b46bbbbbc",
					"repoTags": [
						"project1"
					],
					"size": 125151141,
					"mtime": 1451606400000
				}
			]

			expect(ret).to.deep.equal(output)
