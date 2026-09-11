package main

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
)

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Room struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Polygon []Point `json:"polygon"`
}
type Placement struct {
	Metric   string `json:"metric,omitempty"`
	Network  string `json:"network,omitempty"`
	EntityID string `json:"entity_id"`
	RoomID   string `json:"room_id"`
	Point    Point  `json:"point"`
}
type Door struct {
	ID        string  `json:"id"`
	RoomA     string  `json:"room_a"`
	RoomB     string  `json:"room_b"`
	A         Point   `json:"a"`
	B         Point   `json:"b"`
	Influence float64 `json:"influence"`
}
type Reference struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Point Point  `json:"point"`
}
type Floor struct {
	References []Reference `json:"references,omitempty"`
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	HAFloorID  string      `json:"ha_floor_id"`
	Image      string      `json:"image"`
	Rooms      []Room      `json:"rooms"`
	Sensors    []Placement `json:"sensors"`
	Doors      []Door      `json:"doors"`
}
type Layout struct {
	Version  int      `json:"version"`
	Revision int      `json:"revision"`
	Floors   []Floor  `json:"floors"`
	Ignored  []string `json:"ignored"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
var imagePath = regexp.MustCompile(`^images/[a-f0-9]{32}\.(png|jpg|gif)$`)
var entityID = regexp.MustCompile(`^sensor\.[a-z0-9_]+$`)

func validPoint(p Point) bool {
	return !math.IsNaN(p.X) && !math.IsNaN(p.Y) && p.X >= 0 && p.X <= 1 && p.Y >= 0 && p.Y <= 1
}
func cross(a, b, c Point) float64 { return (b.X-a.X)*(c.Y-a.Y) - (b.Y-a.Y)*(c.X-a.X) }
func onSegment(a, b, p Point) bool {
	return math.Abs(cross(a, b, p)) < 1e-9 && p.X >= math.Min(a.X, b.X)-1e-9 && p.X <= math.Max(a.X, b.X)+1e-9 && p.Y >= math.Min(a.Y, b.Y)-1e-9 && p.Y <= math.Max(a.Y, b.Y)+1e-9
}
func intersects(a, b, c, d Point) bool {
	return cross(a, b, c)*cross(a, b, d) < 0 && cross(c, d, a)*cross(c, d, b) < 0 || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
}
func inside(p Point, poly []Point) bool {
	in := false
	for i, a := range poly {
		b := poly[(i+1)%len(poly)]
		if onSegment(a, b, p) {
			return true
		}
		if (a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X-a.X)*(p.Y-a.Y)/(b.Y-a.Y)+a.X {
			in = !in
		}
	}
	return in
}

func strictlyInside(p Point, poly []Point) bool {
	for i, a := range poly {
		if onSegment(a, poly[(i+1)%len(poly)], p) {
			return false
		}
	}
	return inside(p, poly)
}

func overlaps(a, b []Point) bool {
	for i, p := range a {
		q := a[(i+1)%len(a)]
		if strictlyInside(p, b) {
			return true
		}
		for j, r := range b {
			s := b[(j+1)%len(b)]
			if cross(p, q, r)*cross(p, q, s) < -1e-16 && cross(r, s, p)*cross(r, s, q) < -1e-16 {
				return true
			}
		}
	}
	for _, p := range b {
		if strictlyInside(p, a) {
			return true
		}
	}
	// Identical polygons or collinear partial overlaps have no strict crossings.
	area := 0.0
	for i, p := range a {
		q := a[(i+1)%len(a)]
		area += p.X*q.Y - q.X*p.Y
	}
	for i, p := range a {
		q := a[(i+1)%len(a)]
		length := math.Hypot(q.X-p.X, q.Y-p.Y)
		eps := math.Copysign(1e-7, area)
		probe := Point{(p.X+q.X)/2 - (q.Y-p.Y)/length*eps, (p.Y+q.Y)/2 + (q.X-p.X)/length*eps}
		if strictlyInside(probe, a) && strictlyInside(probe, b) {
			return true
		}
	}
	return false
}

func (l Layout) Validate() error {
	if l.Version != 1 || len(l.Floors) > 20 || len(l.Ignored) > 5000 {
		return errors.New("unsupported layout version or too many floors/sensors")
	}
	floors, entities := map[string]bool{}, map[string]bool{}
	for _, id := range l.Ignored {
		if !entityID.MatchString(id) || entities[id] {
			return errors.New("invalid or duplicate ignored sensor")
		}
		entities[id] = true
	}
	for _, f := range l.Floors {
		if !identifier.MatchString(f.ID) || floors[f.ID] || strings.TrimSpace(f.Name) == "" || len(f.Name) > 100 || !imagePath.MatchString(f.Image) {
			return errors.New("invalid floor ID, name or image")
		}
		floors[f.ID] = true
		if len(f.Rooms) > 100 || len(f.Sensors) > 1000 || len(f.References) > 100 || len(f.Doors) > 200 {
			return errors.New("floor exceeds geometry limits")
		}
		rooms := map[string]Room{}
		for _, r := range f.Rooms {
			if _, ok := rooms[r.ID]; ok || !identifier.MatchString(r.ID) || strings.TrimSpace(r.Name) == "" || len(r.Name) > 100 || len(r.Polygon) < 3 || len(r.Polygon) > 100 {
				return errors.New("invalid room")
			}
			area := 0.0
			for i, p := range r.Polygon {
				if !validPoint(p) {
					return errors.New("room point outside image")
				}
				q := r.Polygon[(i+1)%len(r.Polygon)]
				if p == q {
					return errors.New("duplicate room vertex")
				}
				area += p.X*q.Y - q.X*p.Y
				for j := i + 1; j < len(r.Polygon); j++ {
					if j == i+1 || i == 0 && j == len(r.Polygon)-1 {
						continue
					}
					if intersects(p, q, r.Polygon[j], r.Polygon[(j+1)%len(r.Polygon)]) {
						return fmt.Errorf("room %s has crossing edges", r.Name)
					}
				}
			}
			if math.Abs(area) < 1e-6 {
				return errors.New("room polygon has no area")
			}
			rooms[r.ID] = r
		}
		for i, r := range f.Rooms {
			for _, other := range f.Rooms[i+1:] {
				if overlaps(r.Polygon, other.Polygon) {
					return fmt.Errorf("rooms %s and %s overlap; trace separate interiors", r.Name, other.Name)
				}
			}
		}
		for _, s := range f.Sensors {
			r, ok := rooms[s.RoomID]
			if !validMetric(s.Metric) || (s.Network != "" && s.Network != "wifi" && s.Network != "zigbee") || !entityID.MatchString(s.EntityID) || entities[s.EntityID] || !validPoint(s.Point) || (!signalMetric(s.Metric) && (!ok || !inside(s.Point, r.Polygon))) {
				return errors.New("sensor must be unique and inside its assigned room")
			}
			entities[s.EntityID] = true
		}
		refs := map[string]bool{}
		for _, ref := range f.References {
			if !identifier.MatchString(ref.ID) || refs[ref.ID] || strings.TrimSpace(ref.Name) == "" || len(ref.Name) > 100 || (ref.Kind != "wifi" && ref.Kind != "zigbee") || !validPoint(ref.Point) {
				return errors.New("invalid reference marker")
			}
			refs[ref.ID] = true
		}
		doors := map[string]bool{}
		for _, d := range f.Doors {
			a, okA := rooms[d.RoomA]
			b, okB := rooms[d.RoomB]
			if !identifier.MatchString(d.ID) || doors[d.ID] || !okA || !okB || d.RoomA == d.RoomB || !validPoint(d.A) || !validPoint(d.B) || !inside(d.A, a.Polygon) || !inside(d.B, b.Polygon) || math.IsNaN(d.Influence) || d.Influence < 0 || d.Influence > 1 {
				return errors.New("door endpoints must be in two different rooms; influence must be 0–1")
			}
			doors[d.ID] = true
		}
	}
	return nil
}

func validMetric(metric string) bool {
	switch metric {
	case "", "temperature", "humidity", "rssi", "lqi":
		return true
	}
	return false
}
func signalMetric(metric string) bool { return metric == "rssi" || metric == "lqi" }
