exports.createDot = (tree) ->
	_createDot = (tree) ->
		id = (tree) -> "foo_#{tree.id[0..6]}"

		label = (tree) ->
			name = tree.repoTags[0] or '\\<none\\>:\\<none\\>'
			mtime = new Date(tree.mtime).toISOString()

			return "label=\"{ #{tree.id[0..12]} | #{name} | { #{mtime} | #{tree.size} } }\""

		color = (tree) ->
			if tree.repoTags.length is 0
				'color="black"'
			else
				'color="red"'

		# define the node
		[ "#{id(tree)} [shape=record, #{label(tree)}, #{color(tree)}]" ]
		# define all relations with child nodes
		.concat(("#{id(tree)} -> #{id(child)}" for own _, child of tree.children))
		# recurse to children
		.concat((_createDot(child) for own id, child of tree.children)...)

	return "digraph {\n" + _createDot(tree).join('\n') + '\n}\n'
