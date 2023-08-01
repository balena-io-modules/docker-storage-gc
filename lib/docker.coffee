Docker = require 'dockerode'
Promise = require 'bluebird'
_ = require 'lodash'
path = require 'path'
fs = require 'mz/fs'
url = require 'url'

getDockerConnectOpts = (hostObj) ->
	if !_.isEmpty(hostObj)
		return Promise.resolve(hostObj)
	return Promise.resolve({ socketPath: '/var/run/docker.sock', Promise })

exports.getDocker = (hostObj) ->
	getDockerConnectOpts(hostObj)
	.then (opts) ->
		return new Docker(opts)
