# A bot's computer: one X display per screen, VNC on loopback, a browser that desk.ts dresses.
# The server starts and stops the desktop processes (see server/src/docker/screen.ts); this image
# only has to provide them and stay out of the way.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DISPLAY=:1 \
    HOME=/home/bot
# Fonts and GTK are what the desk's wallpaper, dock and home screen draw with; xdotool/wmctrl are
# what it arranges windows with. ImageMagick is for screenshots.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc tigervnc-scraping-server fluxbox x11-utils x11-xserver-utils xdotool wmctrl \
      chromium \
      python3 python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
      xfce4-terminal xfconf thunar \
      dbus-x11 dbus socat \
      fonts-inter fonts-dejavu-core \
      openssl ca-certificates curl procps psmisc \
      imagemagick \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# fluxbox's default style runs fbsetbg at startup; without a wallpaper tool it opens an error
# dialog on the fresh screen. A plain solid root is what the desk's own wallpaper replaces anyway.
RUN printf '#!/bin/sh\nexec xsetroot -solid "#111113"\n' > /usr/local/bin/fbsetbg \
    && chmod 0755 /usr/local/bin/fbsetbg

COPY entrypoint.sh /usr/local/bin/orbit-computer
RUN chmod 0755 /usr/local/bin/orbit-computer \
    && mkdir -p /home/bot /opt/hq /tmp/.X11-unix

WORKDIR /home/bot
ENTRYPOINT ["/usr/local/bin/orbit-computer"]
