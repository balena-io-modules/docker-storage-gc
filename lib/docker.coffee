Docker = require 'dockerode'
Promise = require 'bluebird'

docker = new Docker(socketPath: '/var/run/docker.sock')
docker = Promise.promisifyAll(docker)
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(Docker({}).getImage().constructor.prototype)

module.exports = docker
