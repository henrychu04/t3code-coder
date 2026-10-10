terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

variable "docker_socket" {
  type = string
}

variable "image_name" {
  type = string
}

provider "docker" {
  host = var.docker_socket
}

data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

resource "coder_agent" "main" {
  arch           = "amd64"
  os             = "linux"
  startup_script = <<-EOT
    set -eu
    python3 -m http.server 18080 --bind 127.0.0.1 --directory /srv/t3-port-forward >/tmp/t3-port-forward.log 2>&1 &
  EOT
}

resource "docker_container" "workspace" {
  count = data.coder_workspace.me.start_count
  image = var.image_name
  name  = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  entrypoint = [
    "sh",
    "-c",
    replace(coder_agent.main.init_script, "/localhost|127\\.0\\.0\\.1/", "host.docker.internal"),
  ]
  env = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]

  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }
}
