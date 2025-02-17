build
docker build -t y-webrtc \
 --build-arg WS_PORT=8080 \
 --build-arg WS_PROTOCOL=ws .
RUN
docker run -d -p 8080:8080 -e WS_PROTOCOL=ws -e WS_PORT=8080 --name y-webrtc-container y-webrtc
