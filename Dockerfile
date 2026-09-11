FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /homeheatmap .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=build /homeheatmap /usr/local/bin/homeheatmap
ENV LISTEN_ADDR=0.0.0.0:8099 DATA_DIR=/data
EXPOSE 8099
ENTRYPOINT ["/usr/local/bin/homeheatmap"]
