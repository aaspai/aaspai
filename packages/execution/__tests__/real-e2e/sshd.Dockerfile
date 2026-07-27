FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server nodejs ca-certificates && rm -rf /var/lib/apt/lists/*
COPY authorized_keys /root/.ssh/authorized_keys
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
