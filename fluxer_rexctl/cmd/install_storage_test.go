// SPDX-License-Identifier: AGPL-3.0-or-later

package cmd

import "testing"

func TestValidStorageEndpoint(t *testing.T) {
	for v, ok := range map[string]bool{
		"https://s3.example.com":             true,
		"http://192.168.1.20:9000":           true,
		"http://localhost:9000":              false,
		"http://minio.localhost:9000":        false,
		"http://127.0.0.1:9000":              false,
		"http://[::1]:9000":                  false,
		"http://[::ffff:127.0.0.1]:9000":     false,
		"http://169.254.169.254":             false,
		"http://0.0.0.0:9000":                false,
		"http://[::]:9000":                   false,
		"https://user:secret@s3.example.com": false,
		"ftp://s3.example.com":               false,
	} {
		if err := validStorageEndpoint(v); (err == nil) != ok {
			t.Errorf("%s: got %v", v, err)
		}
	}
}
