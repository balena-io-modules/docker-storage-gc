_ = require 'lodash'

# arr is array of arrays to be merged
# modifies arrs, TODO: offsets
exports.merge = merge = (arrs, comp) ->
	if not _.isFunction(comp)
		throw new Error('comp is not a function')

	ret = []

	totalLength = _.sum(([arr.length for arr in arrs])...)

	for i in [0...totalLength]
		min = null
		minArrayIndex = null
		for arr, index in arrs when arr.length isnt 0
			if min is null or comp(arr[0], min) < 0
				min = arr[0]
				minArrayIndex = index
		ret.push(min)
		arrs[minArrayIndex].shift()

	return ret

exports.createCompare = (weight, threshold) ->
	(a, b) ->
		now = Date.now()

		if now - a.mtime < threshold or now - b.mtime < threshold
			return a.mtime - b.mtime
		else
			return (a.mtime - b.mtime) * weight + (b.size - a.size) * (1 - weight)

exports.lruSort = lruSort = (tree, compare) ->
	if not _.isFunction(compare)
		throw new Error('compare is not a function')

	tree = _.clone(tree)
	children = tree.children
	delete tree.children

	ret = merge((lruSort(child, compare) for own id, child of children), compare)

	if tree.repoTags.length is 0 and ret.length isnt 0
		ret[ret.length - 1].size += tree.size
	else
		ret.push(tree)

	return ret
