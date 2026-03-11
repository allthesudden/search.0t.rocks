'use strict';

# Updated variable names
name='default_name'
ip='default_ip'
port='default_port'
shards='default_shards'

# Example usage
echo "Name: ${ip:-$name}"
echo "Port: ${port:-$port}"
echo "Shards: ${shards:-$shards}"