package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMeasurementClassification(t *testing.T) {
	cases := []struct {
		id, class, unit, raw, metric string
		valid                        bool
	}{
		{"sensor.room_temperature", "temperature", "°F", "68", "temperature", true},
		{"sensor.room_humidity", "humidity", "%", "52", "humidity", true},
		{"sensor.room_humidity", "humidity", "%", "101", "humidity", false},
		{"sensor.soil_moisture", "moisture", "%", "52", "", false},
		{"binary_sensor.leak", "moisture", "", "on", "", false},
		{"sensor.battery", "battery", "%", "90", "", false},
		{"sensor.wifi_rssi", "signal_strength", "dBm", "-62", "rssi", true},
		{"sensor.snr", "signal_strength", "dB", "20", "", false},
		{"sensor.zigbee_linkquality", "", "lqi", "150", "lqi", true},
		{"sensor.zigbee_linkquality_2", "", "lqi", "150", "lqi", true},
		{"sensor.zigbee_linkquality_123", "", "", "150", "lqi", true},
		{"sensor.linkquality_2", "", "LQI", "150", "lqi", true},
		{"sensor.zigbee_link_quality_2", "", "", "150", "lqi", true},
		{"sensor.zigbee_lqi_2", "", "", "150", "lqi", true},
		{"sensor.zigbee_linkquality_backup", "", "", "150", "", false},
		{"sensor.zigbee_linkquality_2_extra", "", "", "150", "", false},
		{"sensor.zigbee_linkquality_2", "", "%", "80", "", false},
		{"sensor.zigbee_lqi", "", "", "256", "lqi", false},
		{"sensor.wifi_rssi", "signal_strength", "dBm", "unavailable", "rssi", false},
	}
	for _, c := range cases {
		t.Run(c.id+c.raw, func(t *testing.T) {
			s := State{EntityID: c.id, State: c.raw, Attributes: map[string]any{"device_class": c.class, "unit_of_measurement": c.unit}}
			if m := stateMetric(s); m != c.metric {
				t.Fatalf("metric %q, want %q", m, c.metric)
			}
			if v := metricValue(s.State, c.unit, c.metric); (v != nil) != c.valid {
				t.Fatalf("unexpected value %v", v)
			}
		})
	}
}
func TestLayerPlacementValidation(t *testing.T) {
	l := testLayout()
	l.Floors[0].Sensors = append(l.Floors[0].Sensors, Placement{EntityID: "sensor.signal", Metric: "rssi", Point: Point{.9, .9}})
	l.Floors[0].References = []Reference{{ID: "ap", Name: "Access point", Kind: "wifi", Point: Point{.5, .5}}}
	if err := l.Validate(); err != nil {
		t.Fatal(err)
	}
	l.Floors[0].Sensors[1].Metric = "humidity"
	if l.Validate() == nil {
		t.Fatal("humidity accepted outside assigned room")
	}
	l.Floors[0].Sensors[1].Metric = "unknown"
	if l.Validate() == nil {
		t.Fatal("unknown metric accepted")
	}
}
func TestMixedRawHistoryUnits(t *testing.T) {
	start := time.Now().Add(-time.Hour).UTC()
	end := time.Now().UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([][]State{
			{{EntityID: "sensor.air_humidity", State: "55", LastUpdated: start.Format(time.RFC3339), Attributes: map[string]any{"device_class": "humidity", "unit_of_measurement": "%"}}},
			{{EntityID: "sensor.wifi_rssi", State: "-65", LastUpdated: start.Format(time.RFC3339), Attributes: map[string]any{"unit_of_measurement": "dBm"}}},
		})
	}))
	defer server.Close()
	h, _ := NewHA(server.URL, "test")
	result, err := h.History(context.Background(), []string{"sensor.air_humidity", "sensor.wifi_rssi"}, start, end, "states")
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]float64{"sensor.air_humidity": 55, "sensor.wifi_rssi": -65} {
		rows := result.Series[id]
		if len(rows) != 1 || rows[0].Value == nil || *rows[0].Value != want {
			t.Fatalf("bad %s history: %v", id, rows)
		}
	}
}
func TestHistoryFiltersSavedMetric(t *testing.T) {
	var requested string
	start := time.Now().Add(-time.Hour).UTC()
	end := time.Now().UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.Query().Get("filter_entity_id")
		json.NewEncoder(w).Encode([][]State{})
	}))
	defer server.Close()
	h, _ := NewHA(server.URL, "test")
	l := testLayout()
	l.Floors[0].Sensors = append(l.Floors[0].Sensors, Placement{EntityID: "sensor.air_humidity", Metric: "humidity", RoomID: "lounge", Point: Point{.25, .5}})
	a := &application{ha: h, layout: l}
	req := httptest.NewRequest("GET", "/api/history?floor=ground&metric=humidity&start="+start.Format(time.RFC3339)+"&end="+end.Format(time.RFC3339), nil)
	w := httptest.NewRecorder()
	a.history(w, req)
	if w.Code != 200 || requested != "sensor.air_humidity" {
		t.Fatalf("status %d requested %q", w.Code, requested)
	}
}
