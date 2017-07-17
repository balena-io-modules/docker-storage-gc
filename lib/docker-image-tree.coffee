_ = require 'lodash'
dockerUtils = require './docker'

saneRepoTags = (repoTags) ->
	return [] if !repoTags?
	return if '<none>:<none>' in repoTags then [] else repoTags

exports.createNode = createNode = (id) -> { id: id, size: 0, repoTags: [], mtime: null, children: {} }

exports.createTree = createTree = (images) ->
	tree = {}
	root = '0000000000000000000000000000000000000000000000000000000000000000'

	for image in images
		node = tree[image.Id] ?= createNode(image.Id)
		parentId = image.ParentId or root
		parent = tree[parentId] ?= createNode(parentId)

		node.repoTags = saneRepoTags(image.RepoTags)
		node.size = image.Size
		parent.children[image.Id] = node

	return tree[root]

exports.annotateTree = annotateTree = (layer_mtimes, tree) ->
	return {} if !tree?
	return {
		id: tree.id
		repoTags: tree.repoTags
		size: tree.size
		mtime: layer_mtimes[tree.id] or Date.now()
		children: _.mapValues(tree.children, annotateTree.bind(null, layer_mtimes))
	}

exports.dockerImageTree = dockerImageTree = ->
	dockerUtils.getDocker()
	.call('listImages', all: true)
	.then(createTree)
