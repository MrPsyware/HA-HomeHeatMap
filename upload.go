package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

func (a *application) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20)
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		problem(w, 400, errors.New("image upload must be less than 20 MB"))
		return
	}
	defer r.MultipartForm.RemoveAll()
	src, _, err := r.FormFile("image")
	if err != nil {
		problem(w, 400, err)
		return
	}
	defer src.Close()
	config, format, err := image.DecodeConfig(src)
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 12000 || config.Height > 12000 || int64(config.Width)*int64(config.Height) > 40000000 {
		problem(w, 400, errors.New("use a PNG, JPEG or GIF image up to 40 megapixels and 12000 pixels per side"))
		return
	}
	if _, err = src.Seek(0, 0); err != nil {
		problem(w, 400, err)
		return
	}
	ext := map[string]string{"png": "png", "jpeg": "jpg", "gif": "gif"}[format]
	if ext == "" {
		problem(w, 400, errors.New("unsupported image format"))
		return
	}
	var id [16]byte
	if _, err = rand.Read(id[:]); err != nil {
		problem(w, 500, err)
		return
	}
	name := hex.EncodeToString(id[:]) + "." + ext
	path := filepath.Join(a.dir, "images", name)
	dst, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		problem(w, 500, err)
		return
	}
	_, err = io.Copy(dst, src)
	closeErr := dst.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		problem(w, 500, err)
		return
	}
	respond(w, 201, map[string]any{"image": "images/" + name, "width": config.Width, "height": config.Height})
}
