package main

import "testing"

func TestIsLoopbackAddress(t *testing.T) {
	for _, address := range []string{"127.0.0.1:8080", "[::1]:8080", "localhost:8080"} {
		if !isLoopbackAddress(address) {
			t.Errorf("isLoopbackAddress(%q) = false, want true", address)
		}
	}
	for _, address := range []string{"0.0.0.0:8080", ":8080", "192.0.2.10:8080", "bad-address"} {
		if isLoopbackAddress(address) {
			t.Errorf("isLoopbackAddress(%q) = true, want false", address)
		}
	}
}

func TestServeSessionKey(t *testing.T) {
	key, err := serveSessionKey("", true)
	if err != nil {
		t.Fatalf("fixture session key error = %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("fixture session key length = %d, want 32", len(key))
	}
	if _, err := serveSessionKey("", false); err == nil {
		t.Fatal("live session key error = nil")
	}
}
