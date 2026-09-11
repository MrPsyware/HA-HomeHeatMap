package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type HA struct {
	base, token string
	http        *http.Client
	ws          *websocket.Dialer
}

func NewHA(base, token string) (*HA, error) {
	base = strings.TrimRight(base, "/")
	if base != "" {
		u, err := url.Parse(base)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("HA_URL must be an HTTP(S) base URL without credentials, query or fragment")
		}
	}
	dialer := *websocket.DefaultDialer
	return &HA{base: base, token: token, ws: &dialer, http: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// TrustCA adds a local CA to system roots for both REST and WebSocket requests.
// Server identity and certificate validity are still verified.
func (h *HA) TrustCA(path string) error {
	if path == "" {
		return nil
	}
	pem, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read HA_CA_FILE: %w", err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(pem) {
		return errors.New("HA_CA_FILE contains no PEM certificates")
	}
	config := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = config
	h.http.Transport = transport
	h.ws.TLSClientConfig = config
	return nil
}
func (h *HA) configured() bool { return h.base != "" && h.token != "" }
func (h *HA) get(ctx context.Context, path string, out any) error {
	if !h.configured() {
		return errors.New("Home Assistant is not configured; set HA_URL and HA_TOKEN and restart")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", h.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	res, err := h.http.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach Home Assistant: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("Home Assistant returned HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(out)
}
func (h *HA) command(ctx context.Context, cmd map[string]any, out any) error {
	if !h.configured() {
		return errors.New("Home Assistant is not configured")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(h.base, "http") + "/api/websocket"
	conn, _, err := h.ws.DialContext(ctx, wsURL, nil)
	if err != nil {
		return fmt.Errorf("cannot connect to Home Assistant WebSocket API: %w", err)
	}
	defer conn.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	deadline, _ := ctx.Deadline()
	_ = conn.SetReadDeadline(deadline)
	_ = conn.SetWriteDeadline(deadline)
	conn.SetReadLimit(64 << 20)
	var auth struct {
		Type string `json:"type"`
	}
	if err = conn.ReadJSON(&auth); err != nil {
		return err
	}
	if auth.Type != "auth_required" {
		return errors.New("unexpected Home Assistant authentication response")
	}
	if err = conn.WriteJSON(map[string]string{"type": "auth", "access_token": h.token}); err != nil {
		return err
	}
	if err = conn.ReadJSON(&auth); err != nil {
		return err
	}
	if auth.Type != "auth_ok" {
		return errors.New("Home Assistant rejected the access token")
	}
	cmd["id"] = 1
	if err = conn.WriteJSON(cmd); err != nil {
		return err
	}
	var result struct {
		ID      int             `json:"id"`
		Success bool            `json:"success"`
		Result  json.RawMessage `json:"result"`
		Error   struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err = conn.ReadJSON(&result); err != nil {
		return err
	}
	if result.ID != 1 || !result.Success {
		return fmt.Errorf("Home Assistant command %s failed (%s)", cmd["type"], result.Error.Code)
	}
	return json.Unmarshal(result.Result, out)
}

type State struct {
	EntityID    string         `json:"entity_id"`
	State       string         `json:"state"`
	Attributes  map[string]any `json:"attributes"`
	LastChanged string         `json:"last_changed"`
	LastUpdated string         `json:"last_updated"`
}
type Sensor struct {
	Metric   string   `json:"metric"`
	DeviceID string   `json:"device_id,omitempty"`
	Network  string   `json:"network,omitempty"`
	EntityID string   `json:"entity_id"`
	Name     string   `json:"name"`
	Unit     string   `json:"unit"`
	Value    *float64 `json:"value"`
	Updated  string   `json:"updated"`
	AreaID   string   `json:"area_id,omitempty"`
	FloorID  string   `json:"floor_id,omitempty"`
}

func stringAttr(m map[string]any, key string) string { v, _ := m[key].(string); return v }
func celsius(raw, unit string) *float64 {
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	switch unit {
	case "°C", "C":
	case "°F", "F":
		v = (v - 32) * 5 / 9
	case "K":
		v -= 273.15
	default:
		return nil
	}
	return &v
}
func (h *HA) Sensors(ctx context.Context) ([]Sensor, error) {
	var states []State
	if err := h.get(ctx, "/api/states", &states); err != nil {
		return nil, err
	}
	sensors := []Sensor{}
	for _, s := range states {
		unit := stringAttr(s.Attributes, "unit_of_measurement")
		metric := stateMetric(s)
		if metric == "" {
			continue
		}
		name := stringAttr(s.Attributes, "friendly_name")
		if name == "" {
			name = s.EntityID
		}
		sensors = append(sensors, Sensor{EntityID: s.EntityID, Name: name, Unit: unit, Metric: metric, Value: metricValue(s.State, unit, metric), Updated: s.LastUpdated})
	}
	sort.Slice(sensors, func(i, j int) bool { return sensors[i].Name < sensors[j].Name })
	return sensors, nil
}

type HAFloor struct {
	ID    string  `json:"floor_id"`
	Name  string  `json:"name"`
	Level float64 `json:"level"`
}
type HAArea struct {
	ID      string `json:"area_id"`
	Name    string `json:"name"`
	FloorID string `json:"floor_id"`
}
type Catalog struct {
	Sensors  []Sensor  `json:"sensors"`
	Floors   []HAFloor `json:"floors"`
	Areas    []HAArea  `json:"areas"`
	Warnings []string  `json:"warnings"`
}

func (h *HA) Catalog(ctx context.Context) (Catalog, error) {
	sensors, err := h.Sensors(ctx)
	if err != nil {
		return Catalog{}, err
	}
	c := Catalog{Sensors: sensors, Floors: []HAFloor{}, Areas: []HAArea{}, Warnings: []string{}}
	if err = h.command(ctx, map[string]any{"type": "config/floor_registry/list"}, &c.Floors); err != nil {
		c.Warnings = append(c.Warnings, "Could not load HA floors: "+err.Error())
	}
	if err = h.command(ctx, map[string]any{"type": "config/area_registry/list"}, &c.Areas); err != nil {
		c.Warnings = append(c.Warnings, "Could not load HA areas: "+err.Error())
	}
	var entities []struct {
		EntityID string `json:"entity_id"`
		AreaID   string `json:"area_id"`
		DeviceID string `json:"device_id"`
		Platform string `json:"platform"`
	}
	var devices []struct {
		ID     string `json:"id"`
		AreaID string `json:"area_id"`
	}
	if err = h.command(ctx, map[string]any{"type": "config/entity_registry/list"}, &entities); err != nil {
		c.Warnings = append(c.Warnings, "Sensor area suggestions unavailable")
	}
	if err = h.command(ctx, map[string]any{"type": "config/device_registry/list"}, &devices); err != nil {
		c.Warnings = append(c.Warnings, "Device area suggestions unavailable")
	}
	ed, networks := map[string]string{}, map[string]string{}
	da, ea, af := map[string]string{}, map[string]string{}, map[string]string{}
	for _, d := range devices {
		da[d.ID] = d.AreaID
	}
	for _, e := range entities {
		ed[e.EntityID] = e.DeviceID
		if e.Platform == "zha" {
			networks[e.EntityID] = "zigbee"
		}
		if e.Platform == "esphome" || e.Platform == "unifi" {
			networks[e.EntityID] = "wifi"
		}
		ea[e.EntityID] = e.AreaID
		if e.AreaID == "" {
			ea[e.EntityID] = da[e.DeviceID]
		}
	}
	for _, a := range c.Areas {
		af[a.ID] = a.FloorID
	}
	for i := range c.Sensors {
		c.Sensors[i].DeviceID = ed[c.Sensors[i].EntityID]
		c.Sensors[i].Network = networks[c.Sensors[i].EntityID]
		if c.Sensors[i].Metric == "lqi" {
			c.Sensors[i].Network = "zigbee"
		}
		c.Sensors[i].AreaID = ea[c.Sensors[i].EntityID]
		c.Sensors[i].FloorID = af[c.Sensors[i].AreaID]
	}
	sort.Slice(c.Floors, func(i, j int) bool { return c.Floors[i].Level < c.Floors[j].Level })
	return c, nil
}

// Each sample describes an explicit time interval; missing data stays missing.
type Sample struct {
	Start int64    `json:"start"`
	End   int64    `json:"end"`
	Value *float64 `json:"value"`
}
type History struct {
	Start      int64               `json:"start"`
	End        int64               `json:"end"`
	Resolution string              `json:"resolution"`
	Series     map[string][]Sample `json:"series"`
	Warnings   []string            `json:"warnings"`
}

func (a *application) history(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start, e1 := time.Parse(time.RFC3339, q.Get("start"))
	end, e2 := time.Parse(time.RFC3339, q.Get("end"))
	if e1 != nil || e2 != nil || !end.After(start) || end.Sub(start) > 32*24*time.Hour || end.After(time.Now().Add(time.Minute)) {
		problem(w, 400, errors.New("provide a past time range of up to 32 days"))
		return
	}
	a.mu.RLock()
	var ids []string
	for _, f := range a.layout.Floors {
		if f.ID == q.Get("floor") {
			for _, s := range f.Sensors {
				metric := s.Metric
				if metric == "" {
					metric = "temperature"
				}
				wanted := q.Get("metric")
				if wanted == "" {
					wanted = "temperature"
				}
				if metric == wanted {
					ids = append(ids, s.EntityID)
				}
			}
		}
	}
	a.mu.RUnlock()
	if len(ids) == 0 {
		problem(w, 400, errors.New("save at least one sensor on this floor first"))
		return
	}
	mode := q.Get("resolution")
	if mode == "" || mode == "auto" {
		mode = "states"
		if end.Sub(start) > 48*time.Hour {
			mode = "hour"
		}
	}
	if mode != "states" && mode != "hour" {
		problem(w, 400, errors.New("resolution must be auto, states or hour"))
		return
	}
	if mode == "states" && end.Sub(start) > 48*time.Hour {
		problem(w, 400, errors.New("raw state history is limited to 48 hours; use hourly statistics"))
		return
	}
	result, err := a.ha.History(r.Context(), ids, start, end, mode)
	if err != nil {
		problem(w, 502, err)
		return
	}
	respond(w, 200, result)
}
func (h *HA) History(ctx context.Context, ids []string, start, end time.Time, mode string) (History, error) {
	result := History{Start: start.UnixMilli(), End: end.UnixMilli(), Resolution: mode, Series: map[string][]Sample{}, Warnings: []string{}}
	for _, id := range ids {
		result.Series[id] = []Sample{}
	}
	if mode == "hour" {
		var series map[string][]struct {
			Start float64  `json:"start"`
			End   float64  `json:"end"`
			Mean  *float64 `json:"mean"`
		}
		err := h.command(ctx, map[string]any{"type": "recorder/statistics_during_period", "statistic_ids": ids, "start_time": start.UTC().Format(time.RFC3339), "end_time": end.UTC().Format(time.RFC3339), "period": "hour", "types": []string{"mean"}, "units": map[string]string{"temperature": "°C"}}, &series)
		if err != nil {
			return result, err
		}
		for id, rows := range series {
			for _, row := range rows {
				if row.End <= row.Start {
					continue
				}
				result.Series[id] = append(result.Series[id], Sample{Start: int64(row.Start), End: int64(row.End), Value: row.Mean})
			}
		}
	} else {
		params := url.Values{"filter_entity_id": {strings.Join(ids, ",")}, "end_time": {end.UTC().Format(time.RFC3339)}}
		var series [][]State
		if err := h.get(ctx, "/api/history/period/"+start.UTC().Format(time.RFC3339)+"?"+params.Encode(), &series); err != nil {
			return result, err
		}
		for _, rows := range series {
			if len(rows) == 0 {
				continue
			}
			id := rows[0].EntityID
			if _, ok := result.Series[id]; !ok {
				continue
			}
			samples := []Sample{}
			for _, row := range rows {
				stamp := row.LastUpdated
				if stamp == "" {
					stamp = row.LastChanged
				}
				t, err := time.Parse(time.RFC3339Nano, stamp)
				if err != nil {
					continue
				}
				samples = append(samples, Sample{Start: t.UnixMilli(), End: end.UnixMilli(), Value: metricValue(row.State, stringAttr(row.Attributes, "unit_of_measurement"), stateMetric(row))})
			}
			sort.SliceStable(samples, func(i, j int) bool { return samples[i].Start < samples[j].Start })
			for i := 0; i+1 < len(samples); i++ {
				samples[i].End = samples[i+1].Start
			}
			result.Series[id] = samples
		}
	}
	for _, id := range ids {
		rows := result.Series[id]
		sort.Slice(rows, func(i, j int) bool { return rows[i].Start < rows[j].Start })
		valid := false
		for _, row := range rows {
			if row.Value != nil {
				valid = true
				break
			}
		}
		if !valid {
			result.Warnings = append(result.Warnings, id+": no data in this range")
		}
	}
	return result, nil
}

// Only compatible numeric measurements enter a layer. Soil moisture and binary
// leak sensors are not relative humidity; dB ratios are not dBm RSSI.
var linkQualityName = regexp.MustCompile(`(?:^|[._])(?:linkquality|link_quality|lqi)(?:_[0-9]+)?$`)

func stateMetric(s State) string {
	if !strings.HasPrefix(s.EntityID, "sensor.") {
		return ""
	}
	unit, class := stringAttr(s.Attributes, "unit_of_measurement"), stringAttr(s.Attributes, "device_class")
	name := strings.ToLower(s.EntityID)
	if class == "temperature" || unit == "°C" || unit == "°F" || unit == "K" {
		return "temperature"
	}
	if unit == "%" && (class == "humidity" || (class == "" && (strings.HasSuffix(name, "_humidity") || strings.HasSuffix(name, "_relative_humidity")))) {
		return "humidity"
	}
	if unit == "dBm" {
		return "rssi"
	}
	if linkQualityName.MatchString(name) {
		if unit == "" || unit == "lqi" || unit == "LQI" {
			return "lqi"
		}
	}
	return ""
}
func metricValue(raw, unit, metric string) *float64 {
	if metric == "temperature" {
		return celsius(raw, unit)
	}
	if metric == "" {
		return nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	if metric == "humidity" && (unit != "%" || v < 0 || v > 100) {
		return nil
	}
	if metric == "rssi" && unit != "dBm" {
		return nil
	}
	if metric == "lqi" && (v < 0 || v > 255) {
		return nil
	}
	return &v
}
