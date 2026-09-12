package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func transferFixture(t *testing.T, mutate func(map[string][]byte)) []byte {
	t.Helper()
	layout := testLayout()
	data, _ := json.Marshal(layout)
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 10, 10))); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{"layout.json": data, layout.Floors[0].Image: img.Bytes()}
	if mutate != nil {
		mutate(files)
	}
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	for name, data := range files {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func TestTransferRejectsInvalidBundles(t *testing.T) {
	for name, mutate := range map[string]func(map[string][]byte){
		"missing image": func(f map[string][]byte) { delete(f, testLayout().Floors[0].Image) },
		"traversal":     func(f map[string][]byte) { f["../layout.json"] = []byte("bad") },
		"credentials":   func(f map[string][]byte) { f[".env"] = []byte("HA_TOKEN=private") },
		"invalid image": func(f map[string][]byte) { f[testLayout().Floors[0].Image] = []byte("not an image") },
		"invalid geometry": func(f map[string][]byte) {
			l := testLayout()
			l.Floors[0].Sensors[0].Point = Point{2, 2}
			f["layout.json"], _ = json.Marshal(l)
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := readTransfer(transferFixture(t, mutate)); err == nil {
				t.Fatal("bad bundle accepted")
			}
		})
	}
}
func TestTransferPersistenceBackupAndStaleRevision(t *testing.T) {
	ha, _ := NewHA("", "")
	a, err := newApplication(t.TempDir(), ha, false)
	if err != nil {
		t.Fatal(err)
	}
	a.layout = testLayout()
	a.layout.Revision = 7
	oldImage := filepath.Join(a.dir, a.layout.Floors[0].Image)
	if err = os.WriteFile(oldImage, []byte("previous image"), 0600); err != nil {
		t.Fatal(err)
	}
	request := func(revision string, body []byte) int {
		r := httptest.NewRequest("POST", "/api/import?revision="+revision, bytes.NewReader(body))
		r.Header.Set("X-Heatmap-Request", "1")
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		return w.Code
	}
	bundle := transferFixture(t, nil)
	if code := request("6", bundle); code != 409 {
		t.Fatalf("stale import: %d", code)
	}
	if code := request("7", bundle); code != 200 {
		t.Fatalf("import: %d", code)
	}
	if a.layout.Revision != 8 || a.layout.Floors[0].Image == testLayout().Floors[0].Image {
		t.Fatal("revision/image not replaced safely")
	}
	if data, _ := os.ReadFile(oldImage); string(data) != "previous image" {
		t.Fatal("old image overwritten")
	}
	backups, _ := filepath.Glob(filepath.Join(a.dir, "layout-before-import-*.json"))
	if len(backups) != 1 {
		t.Fatal("missing backup")
	}
	var previous Layout
	data, _ := os.ReadFile(backups[0])
	if json.Unmarshal(data, &previous) != nil || previous.Revision != 7 {
		t.Fatal("bad backup")
	}
	loaded, err := newApplication(a.dir, ha, false)
	if err != nil || loaded.layout.Revision != 8 {
		t.Fatalf("persistence failed: %v", err)
	}
	if _, err = os.Stat(filepath.Join(a.dir, loaded.layout.Floors[0].Image)); err != nil {
		t.Fatal(err)
	}
	if code := request("8", transferFixture(t, func(f map[string][]byte) { delete(f, "layout.json") })); code != 400 {
		t.Fatal("invalid import accepted")
	}
	if a.layout.Revision != 8 {
		t.Fatal("failed import changed layout")
	}
}
