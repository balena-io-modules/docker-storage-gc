Docker = require 'dockerode'
Promise = require 'bluebird'
_ = require 'lodash'

getDockerConnectOpts = (hostObj) ->
	if !_.isEmpty(hostObj)
		return Promise.resolve(hostObj)
	return Promise.resolve({ socketPath: '/var/run/docker.sock', Promise })

exports.getDocker = (hostObj) ->
	getDockerConnectOpts(hostObj)
	.then (opts) ->
		return new Docker(opts)
