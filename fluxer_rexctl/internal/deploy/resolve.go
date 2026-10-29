// SPDX-License-Identifier: AGPL-3.0-or-later

package deploy

import (
	"context"
	"fmt"
	"strings"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/engine"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/instance"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/settings"
)

func Interrupted(inst *instance.Instance) string {
	p := inst.State.Pending
	if p == nil {
		return ""
	}
	if len(p.Keys) == 1 {
		return fmt.Sprintf("The change to %s didn't finish. rexctl put the old value back.", p.Keys[0])
	}
	if len(p.Keys) == 0 {
		return "The last settings change didn't finish. rexctl put the old values back."
	}
	return fmt.Sprintf("The change to %s and %s didn't finish. rexctl put the old values back.",
		strings.Join(p.Keys[:len(p.Keys)-1], ", "), p.Keys[len(p.Keys)-1])
}

func Resolve(ctx context.Context, inst *instance.Instance, e *engine.Engine) error {
	p := inst.State.Pending
	if p == nil {
		return nil
	}
	rs, err := ReleaseSet(inst)
	if err != nil {
		return err
	}
	ipv6 := parseBool(p.Settings[settings.IPv6]) != parseBool(inst.State.Settings[settings.IPv6])
	if _, err := render(inst, rs, inst.State.Settings); err != nil {
		return err
	}
	if err := save(inst); err != nil {
		return err
	}
	if ipv6 {
		if err := e.Named(inst.Project(), inst.Dir).Down(context.WithoutCancel(ctx), false); err != nil {
			return err
		}
	}
	if !inst.State.Stopped {
		s, err := specFor(inst, rs, inst.State.Settings)
		if err != nil {
			return err
		}
		proj, err := e.Load(ctx, s)
		if err != nil {
			return err
		}
		if err := up(ctx, proj, true, nil); err != nil {
			return err
		}
	}
	inst.State.Pending = nil
	return save(inst)
}
