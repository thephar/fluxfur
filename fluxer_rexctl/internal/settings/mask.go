// SPDX-License-Identifier: AGPL-3.0-or-later

package settings

import (
	"net/url"
	"strings"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/secrets"
)

const Masked = "set"

var secretParts = []string{"PASSWORD", "SECRET", "_TOKEN", "PRIVATE_KEY", "COOKIE", "API_KEY", "PROXY_KEY", "BLUESKY_KEYS", "SECRETS_BASE64"}

func SecretName(name string) bool {
	for _, p := range secretParts {
		if strings.Contains(name, p) {
			return true
		}
	}
	for _, s := range secrets.Required {
		if s.Key == name {
			return s.Kind != secrets.KindFixed && s.Key != secrets.VAPIDPublicKey
		}
	}
	return false
}

func Mask(key Key, value string) string {
	if value == "" {
		return ""
	}
	if key.Secret {
		return Masked
	}
	return maskUserinfo(value)
}

func maskUserinfo(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.User == nil || u.Host == "" {
		return value
	}
	u.User = nil
	return strings.Replace(u.String(), "://", "://•••@", 1)
}
