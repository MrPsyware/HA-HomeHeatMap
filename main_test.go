package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testLayout() Layout {
	return Layout{Version: 1, Floors: []Floor{{ID: "ground", Name: "Ground", Image: "images/0123456789abcdef0123456789abcdef.png", Rooms: []Room{{ID: "lounge", Name: "Lounge", Polygon: []Point{{0, 0}, {.5, 0}, {.5, 1}, {0, 1}}}, {ID: "study", Name: "Study", Polygon: []Point{{.5, 0}, {1, 0}, {1, 1}, {.5, 1}}}}, Sensors: []Placement{{EntityID: "sensor.lounge", RoomID: "lounge", Point: Point{.25, .5}}}, Doors: []Door{{ID: "door", RoomA: "lounge", RoomB: "study", A: Point{.49, .5}, B: Point{.51, .5}, Influence: .35}}}}, Ignored: []string{}}
}
func TestGeometryValidation(t *testing.T) {
	if err := testLayout().Validate(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*Layout){"outside sensor": func(l *Layout) { l.Floors[0].Sensors[0].Point = Point{.8, .5} }, "crossed polygon": func(l *Layout) { l.Floors[0].Rooms[0].Polygon = []Point{{0, 0}, {.5, 1}, {0, 1}, {.5, 0}} }, "invalid doorway": func(l *Layout) { l.Floors[0].Doors[0].RoomB = "missing" }, "image traversal": func(l *Layout) { l.Floors[0].Image = "../secret" }, "ignored placement": func(l *Layout) { l.Ignored = []string{"sensor.lounge"} }}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			l := testLayout()
			mutate(&l)
			if l.Validate() == nil {
				t.Fatal("invalid layout accepted")
			}
		})
	}
}

func TestRoomOverlap(t *testing.T) {
	l := testLayout()
	if err := l.Validate(); err != nil {
		t.Fatalf("shared wall rejected: %v", err)
	}
	l.Floors[0].Rooms[1].Polygon = append([]Point(nil), l.Floors[0].Rooms[0].Polygon...)
	if l.Validate() == nil {
		t.Fatal("identical rooms accepted")
	}
	l = testLayout()
	l.Floors[0].Rooms[1].Polygon[0].X = .4
	l.Floors[0].Rooms[1].Polygon[3].X = .4
	if l.Validate() == nil {
		t.Fatal("partially overlapping rooms accepted")
	}
}
func TestSaveUploadAndIngress(t *testing.T) {
	ha, _ := NewHA("", "")
	dir := t.TempDir()
	a, err := newApplication(dir, ha, false)
	if err != nil {
		t.Fatal(err)
	}
	handler := a.handler()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, _ := form.CreateFormFile("image", "floor.png")
	_ = png.Encode(part, image.NewRGBA(image.Rect(0, 0, 10, 10)))
	_ = form.Close()
	req := httptest.NewRequest("POST", "/api/images", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-Heatmap-Request", "1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != 201 {
		t.Fatal(res.Body.String())
	}
	var uploaded struct {
		Image string `json:"image"`
	}
	_ = json.Unmarshal(res.Body.Bytes(), &uploaded)
	l := testLayout()
	l.Floors[0].Image = uploaded.Image
	save := func(origin string) *httptest.ResponseRecorder {
		data, _ := json.Marshal(l)
		r := httptest.NewRequest("PUT", "/api/layout", bytes.NewReader(data))
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Heatmap-Request", "1")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := save("http://evil.example"); w.Code != 403 {
		t.Fatal("cross-origin write allowed")
	}
	if w := save("http://example.com"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := save("http://example.com"); w.Code != 409 {
		t.Fatal("stale layout overwrote newer setup")
	}
	reloaded, err := newApplication(dir, ha, false)
	if err != nil || reloaded.layout.Revision != 1 {
		t.Fatalf("persistent layout failed: %v", err)
	}
	if _, err = os.Stat(filepath.Join(dir, "layout.json")); err != nil {
		t.Fatal(err)
	}
	a.ingress = true
	req = httptest.NewRequest("GET", "/api/status", nil)
	req.RemoteAddr = "192.168.1.2:1234"
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != 403 {
		t.Fatal("direct ingress request permitted")
	}
	req.RemoteAddr = "172.30.32.2:1234"
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), "secret") {
		t.Fatal("bad status response")
	}
}
