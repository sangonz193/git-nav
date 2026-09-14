# Fedora tracks Mesa closely, which is where the AppImage's bundled display libraries fall out
# of step with the host GL stack.
FROM fedora:44
RUN dnf install -y \
      xorg-x11-server-Xvfb ImageMagick git \
      mesa-dri-drivers mesa-libEGL mesa-libGL mesa-libgbm \
      gtk3 libsoup3 gdk-pixbuf2 \
      libwayland-client libwayland-cursor libwayland-egl libwayland-server \
 && dnf clean all
RUN git config --global user.email smoke@example.com \
 && git config --global user.name smoke \
 && git init /repo && git -C /repo commit --allow-empty -m init
COPY run.sh /run.sh
WORKDIR /repo
ENTRYPOINT ["/bin/bash", "/run.sh"]
