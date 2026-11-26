# Reaching the server through a tunnel

This page is part of [setting up agents](operator-guide.md#agents), which introduces the bridge and
its `AGENTION_CONNECT` setting.

Some machines where agents run accept connections but can't open one to the server, such as virtual
machines on another network, or another tailnet, whose rules let connections reach them but not
leave for the server. The server's machine can then hold an SSH reverse tunnel into each of them: a
forward from a port on the agent machine's loopback, such as `127.0.0.1:8443`, to the server's
origin. The bridge there opens its connections at that port, set in `AGENTION_CONNECT`, while
everything else still names the origin.

TLS stays end to end. The tunnel carries the bridge's TLS connection to whatever serves the origin,
and the bridge checks the certificate against the origin's host name, as it does without a tunnel.
Authentication is unchanged: agents register, and you approve them, as anywhere else. While the
tunnel is up, every user on the agent machine can reach the server's sign-in page and agent API
through its port, even a server otherwise reachable only on a private network; as from anywhere
else, a registration still waits for your approval, and nothing can be read without an approved key
or your passkey. While the tunnel is down, anyone on the agent machine can listen at its port, but
can't present the server's certificate, so the bridge sends them nothing, and its agent tells you
that the server can't be reached at the address in `AGENTION_CONNECT`.

What the tunnel adds is the server machine's SSH key on each agent machine, which the steps below
limit to that one forward. The key's options and the `Match` block below have been tested with
OpenSSH 9.2; the rest of these steps have not been run yet. They use port 8443 on the agent
machine's loopback; any free port works, the same one in the key's line, the tunnel and
`AGENTION_CONNECT`.

On each agent machine, with `sudo`:

1. Create a user for the tunnel alone, which needs no shell, and its `authorized_keys` file. The
   file and its directory must belong to that user and be writable by it alone, or the SSH server
   ignores them:

   ```bash
   sudo useradd --create-home --shell /usr/sbin/nologin agention-tunnel
   sudo install -d -m 700 -o agention-tunnel -g agention-tunnel /home/agention-tunnel/.ssh
   sudo install -m 600 -o agention-tunnel -g agention-tunnel /dev/null /home/agention-tunnel/.ssh/authorized_keys
   ```

2. Put this line in that file, such as with `sudoedit /home/agention-tunnel/.ssh/authorized_keys`,
   with the public key the server's machine makes below in place of `ssh-ed25519 AAAA...`:

   ```text
   restrict,port-forwarding,permitlisten="127.0.0.1:8443",command="false" ssh-ed25519 AAAA... agention-tunnel
   ```

   `restrict` turns off everything the key could do beyond logging in, `port-forwarding` turns
   forwarding back on, `permitlisten` lets the key's forwards listen only at the tunnel's port, and
   `command` replaces any shell or command the key asks for.

3. Turn off the forwards that a key's options can't: those into this machine, which `ssh -L` and
   `ssh -D` make, and those of Unix sockets. Keep the tunnel's port on loopback whatever the rest of
   the file says, since `GatewayPorts yes` would otherwise open it on every address. Have the SSH
   server also drop a tunnel's connection that stops answering, which frees its port for the next
   connection within about two minutes. Add this at the end of `/etc/ssh/sshd_config`, check it with
   `sudo sshd -t`, and reload the SSH server, with `sudo systemctl reload ssh` on Debian and Ubuntu
   or `sudo systemctl reload sshd` elsewhere:

   ```text
   Match User agention-tunnel
       AllowTcpForwarding remote
       AllowStreamLocalForwarding no
       GatewayPorts no
       ClientAliveInterval 15
       ClientAliveCountMax 3
   ```

On the server's machine, as the user that runs the server:

1. Make a key for the tunnels, without a passphrase, since nobody is there to type it, and use its
   public half, `~/.ssh/agention-tunnel.pub`, in the line above:

   ```bash
   mkdir -p -m 700 ~/.ssh
   ssh-keygen -t ed25519 -N '' -C agention-tunnel -f ~/.ssh/agention-tunnel
   ```

2. Connect to each agent machine once to check and accept its host key. The SSH server runs the
   key's command through the account's shell, so `nologin` answers that the account is not
   available, and the connection closes:

   ```bash
   ssh -i ~/.ssh/agention-tunnel agention-tunnel@agent-vm.example.net
   ```

3. Save this as `~/.config/systemd/user/agention-tunnel@.service`, with your origin's host in place
   of `agention.example.com`, and its port, if it names one, in place of `443`. The tunnel must lead
   to the origin, where the server's certificate is served, never to the server's own port, which
   answers without TLS when a proxy such as `tailscale serve` holds the certificate:

   ```ini
   [Unit]
   Description=Agention tunnel into %i

   [Service]
   ExecStart=/usr/bin/ssh -N -i %h/.ssh/agention-tunnel -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 127.0.0.1:8443:agention.example.com:443 agention-tunnel@%i
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=default.target
   ```

   Then start a tunnel into each agent machine, named after the `@`, and have it start whenever your
   user's services do, which lingering, turned on for
   [the server's own unit](operator-guide.md#linux-a-systemd-user-unit), makes at boot:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now agention-tunnel@agent-vm.example.net
   ```

   `ssh` exits when its connection stops answering, or when the agent machine refuses the forward,
   as it does while a connection that broke still holds the port, until the `Match` block's settings
   drop it. systemd starts `ssh` again ten seconds later each time, so a tunnel comes back on its
   own once both machines can reach each other.
   `systemctl --user status agention-tunnel@agent-vm.example.net` shows whether a tunnel is up, and
   `journalctl --user -u agention-tunnel@agent-vm.example.net` why it last stopped.

Then give the bridge on each agent machine the tunnel's port beside the origin, as
[Installing the plugins](operator-guide.md#installing-the-plugins) describes for `AGENTION_URL`; an
IPv6 address goes in brackets, such as `[::1]:8443`:

```bash
export AGENTION_URL=https://agention.example.com
export AGENTION_CONNECT=127.0.0.1:8443
```
