package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestPrivateCertificateAuthority(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w, 200, []State{}) }))
	defer server.Close()
	ha, _ := NewHA(server.URL, "secret")
	if _, err := ha.Sensors(context.Background()); err == nil {
		t.Fatal("untrusted server accepted")
	}
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ha.TrustCA(path); err != nil {
		t.Fatal(err)
	}
	if _, err := ha.Sensors(context.Background()); err != nil {
		t.Fatalf("private CA failed: %v", err)
	}
	if ha.ws.TLSClientConfig.RootCAs != ha.http.Transport.(*http.Transport).TLSClientConfig.RootCAs {
		t.Fatal("REST and WS must share trust roots")
	}
}

func TestTemperatureUnits(t *testing.T) {
	for _, tc := range []struct {
		raw, unit string
		want      float64
	}{{"68", "°F", 20}, {"293.15", "K", 20}, {"21.7", "°C", 21.7}} {
		v := celsius(tc.raw, tc.unit)
		if v == nil || *v != tc.want {
			t.Errorf("%s %s = %v", tc.raw, tc.unit, v)
		}
	}
	for _, raw := range []string{"unavailable", "unknown", "NaN", "+Inf"} {
		if celsius(raw, "°C") != nil {
			t.Errorf("accepted invalid state %q", raw)
		}
	}
	if celsius("20", "unknown") != nil {
		t.Fatal("unknown units must not be treated as Celsius")
	}
}
func TestRawHistoryPreservesUnavailableAndUnits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing authentication")
		}
		if r.URL.Query().Get("filter_entity_id") != "sensor.room" {
			t.Error("missing entity filter")
		}
		_ = json.NewEncoder(w).Encode([][]State{{
			{EntityID: "sensor.room", State: "68", LastChanged: "2026-09-01T00:00:00Z", Attributes: map[string]any{"unit_of_measurement": "°F"}},
			{EntityID: "sensor.room", State: "unavailable", LastChanged: "2026-09-01T01:00:00Z"},
			{EntityID: "sensor.room", State: "22", LastChanged: "2026-09-01T02:00:00Z", Attributes: map[string]any{"unit_of_measurement": "°C"}},
		}})
	}))
	defer server.Close()
	ha, _ := NewHA(server.URL, "secret")
	start, _ := time.Parse(time.RFC3339, "2026-09-01T00:00:00Z")
	result, err := ha.History(context.Background(), []string{"sensor.room"}, start, start.Add(3*time.Hour), "states")
	if err != nil {
		t.Fatal(err)
	}
	rows := result.Series["sensor.room"]
	if len(rows) != 3 || *rows[0].Value != 20 || rows[1].Value != nil || *rows[2].Value != 22 || rows[0].End != rows[1].Start || rows[2].End != start.Add(3*time.Hour).UnixMilli() {
		t.Fatalf("unexpected intervals: %+v", rows)
	}
}
func TestStatisticsWebSocket(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/websocket" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{"type": "auth_required"})
		var auth map[string]any
		if err = conn.ReadJSON(&auth); err != nil {
			t.Error(err)
			return
		}
		if auth["access_token"] != "secret" {
			t.Error("missing WS token")
		}
		_ = conn.WriteJSON(map[string]any{"type": "auth_ok"})
		var cmd map[string]any
		if err = conn.ReadJSON(&cmd); err != nil {
			t.Error(err)
			return
		}
		if cmd["type"] != "recorder/statistics_during_period" || cmd["period"] != "hour" {
			t.Errorf("wrong command: %v", cmd)
		}
		units := cmd["units"].(map[string]any)
		if units["temperature"] != "°C" {
			t.Error("statistics unit conversion missing")
		}
		_ = conn.WriteJSON(map[string]any{"id": 1, "success": true, "result": map[string]any{"sensor.room": []map[string]any{{"start": 1788220800000, "end": 1788224400000, "mean": 20.5}, {"start": 1788228000000, "end": 1788231600000, "mean": 21}}}})
	}))
	defer server.Close()
	ha, _ := NewHA(server.URL, "secret")
	start := time.UnixMilli(1788220800000)
	result, err := ha.History(context.Background(), []string{"sensor.room", "sensor.empty"}, start, start.Add(24*time.Hour), "hour")
	if err != nil {
		t.Fatal(err)
	}
	rows := result.Series["sensor.room"]
	if len(rows) != 2 || *rows[0].Value != 20.5 || rows[0].End == rows[1].Start {
		t.Fatal("hourly gap was not retained")
	}
	if len(result.Warnings) != 1 {
		t.Fatal("missing data warning absent")
	}
}
