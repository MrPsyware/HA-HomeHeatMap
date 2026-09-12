package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Import only the layout and referenced images. Never extract archive paths or
// accept credentials. New image names preserve all existing files for rollback.
func (a *application) importLayout(w http.ResponseWriter, r *http.Request) {
	revision, err := strconv.Atoi(r.URL.Query().Get("revision"))
	if err != nil || revision < 0 {
		problem(w, 400, errors.New("current layout revision is required"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		problem(w, 400, errors.New("transfer ZIP must be no larger than 100 MB"))
		return
	}
	next, images, err := readTransfer(raw)
	if err != nil {
		problem(w, 400, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if revision != a.layout.Revision {
		problem(w, 409, errors.New("layout changed in another tab; reload before importing"))
		return
	}
	written := []string{}
	committed := false
	defer func() {
		if !committed {
			for _, path := range written {
				_ = os.Remove(path)
			}
		}
	}()
	names := map[string]string{}
	for old, data := range images {
		var id [16]byte
		if _, err = rand.Read(id[:]); err != nil {
			problem(w, 500, err)
			return
		}
		name := "images/" + hex.EncodeToString(id[:]) + filepath.Ext(old)
		path := filepath.Join(a.dir, filepath.FromSlash(name))
		dst, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			problem(w, 500, e)
			return
		}
		written = append(written, path)
		_, err = dst.Write(data)
		closeErr := dst.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			problem(w, 500, err)
			return
		}
		names[old] = name
	}
	for i := range next.Floors {
		next.Floors[i].Image = names[next.Floors[i].Image]
	}
	next.Revision = a.layout.Revision + 1
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		problem(w, 500, err)
		return
	}
	// Keep the previous layout alongside its untouched images before replacement.
	backup, err := json.MarshalIndent(a.layout, "", "  ")
	if err == nil {
		err = atomicWrite(filepath.Join(a.dir, fmt.Sprintf("layout-before-import-%d.json", time.Now().UnixNano())), backup)
	}
	if err == nil {
		err = atomicWrite(filepath.Join(a.dir, "layout.json"), data)
	}
	if err != nil {
		problem(w, 500, err)
		return
	}
	a.layout = next
	committed = true
	respond(w, 200, next)
}

func readTransfer(raw []byte) (Layout, map[string][]byte, error) {
	var layout Layout
	fail := func(message string) (Layout, map[string][]byte, error) { return Layout{}, nil, errors.New(message) }
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return fail("choose a valid transfer ZIP")
	}
	if len(archive.File) > 25 {
		return fail("too many files in transfer ZIP")
	}
	files := map[string][]byte{}
	var total uint64
	for _, entry := range archive.File {
		name := entry.Name
		if name != "layout.json" && !imagePath.MatchString(name) {
			return fail("ZIP may contain only layout.json and images/<id>.png, .jpg or .gif")
		}
		if _, ok := files[name]; ok {
			return fail("duplicate file in transfer ZIP")
		}
		limit := uint64(20 << 20)
		if name == "layout.json" {
			limit = 2 << 20
		}
		total += entry.UncompressedSize64
		if entry.UncompressedSize64 > limit || total > 100<<20 {
			return fail("transfer ZIP exceeds image, layout or total size limit")
		}
		src, e := entry.Open()
		if e != nil {
			return fail("cannot read transfer ZIP entry")
		}
		data, e := io.ReadAll(io.LimitReader(src, int64(limit)+1))
		_ = src.Close()
		if e != nil || uint64(len(data)) > limit {
			return fail("corrupt or oversized transfer ZIP entry")
		}
		files[name] = data
	}
	data, ok := files["layout.json"]
	if !ok {
		return fail("ZIP is missing layout.json")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&layout); err != nil {
		return fail("invalid layout.json: " + err.Error())
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return fail("layout.json must contain one JSON object")
	}
	if err = layout.Validate(); err != nil {
		return fail("invalid layout: " + err.Error())
	}
	images := map[string][]byte{}
	for _, floor := range layout.Floors {
		data, ok := files[floor.Image]
		if !ok {
			return fail("ZIP is missing a referenced floor image")
		}
		cfg, format, e := image.DecodeConfig(bytes.NewReader(data))
		if e != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 12000 || cfg.Height > 12000 || int64(cfg.Width)*int64(cfg.Height) > 40000000 {
			return fail("invalid floor image or image exceeds 40 megapixels")
		}
		ext := map[string]string{"png": ".png", "jpeg": ".jpg", "gif": ".gif"}[format]
		if ext == "" || ext != filepath.Ext(floor.Image) {
			return fail("floor image format does not match its filename")
		}
		images[floor.Image] = data
	}
	if len(files) != len(images)+1 {
		return fail("ZIP contains unreferenced files")
	}
	return layout, images, nil
}
