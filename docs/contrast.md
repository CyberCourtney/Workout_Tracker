# Contrast check

WCAG 2.1 contrast ratios for every text/background pair in the redesign (computed with the WCAG relative-luminance formula). Body text needs 4.5:1; large text (24px+, or 19px+ bold) needs 3:1. Tinted backgrounds are the actual mixed colour (e.g. 16–18% of the feature colour over the surface).

Where a palette colour is too light for text on a light surface, the light theme uses a darker "ink" shade of the same hue (e.g. sky `#2EC5FF` → `#086A92`). Text on bright fills is always navy `#0F1024`. Primary buttons use a violet tint (`#8C7CF0`) at the start of the violet→sky gradient so navy text passes at both ends.

| Theme | Use | Text | Background | Ratio | Needs |
|---|---|---|---|---|---|
| dark | Body text on bg | `#F7F7FB` | `#0F1024` | 17.55:1 | 4.5:1 ✓ |
| dark | Secondary text on bg | `#B9BBD6` | `#0F1024` | 9.95:1 | 4.5:1 ✓ |
| dark | Body text on surface | `#F7F7FB` | `#1B1C3A` | 15.43:1 | 4.5:1 ✓ |
| dark | Secondary text on surface | `#B9BBD6` | `#1B1C3A` | 8.75:1 | 4.5:1 ✓ |
| dark | Body text on s2 | `#F7F7FB` | `#262849` | 13.26:1 | 4.5:1 ✓ |
| dark | Secondary text on s2 | `#B9BBD6` | `#262849` | 7.52:1 | 4.5:1 ✓ |
| dark | Muted labels (weekdays, placeholders) on surface | `#9A9CC0` | `#1B1C3A` | 6.19:1 | 4.5:1 ✓ |
| dark | Muted labels on surface-2 (set inputs) | `#9A9CC0` | `#262849` | 5.32:1 | 4.5:1 ✓ |
| dark | violet ink text on surface | `#A29BFE` | `#1B1C3A` | 6.80:1 | 4.5:1 ✓ |
| dark | violet ink text on bg | `#A29BFE` | `#0F1024` | 7.73:1 | 4.5:1 ✓ |
| dark | sky ink text on surface | `#2EC5FF` | `#1B1C3A` | 8.28:1 | 4.5:1 ✓ |
| dark | sky ink text on bg | `#2EC5FF` | `#0F1024` | 9.42:1 | 4.5:1 ✓ |
| dark | coral ink text on surface | `#FF8A8A` | `#1B1C3A` | 7.27:1 | 4.5:1 ✓ |
| dark | coral ink text on bg | `#FF8A8A` | `#0F1024` | 8.26:1 | 4.5:1 ✓ |
| dark | lime ink text on surface | `#B8F23A` | `#1B1C3A` | 12.40:1 | 4.5:1 ✓ |
| dark | lime ink text on bg | `#B8F23A` | `#0F1024` | 14.11:1 | 4.5:1 ✓ |
| dark | mango ink text on surface | `#FFB547` | `#1B1C3A` | 9.38:1 | 4.5:1 ✓ |
| dark | mango ink text on bg | `#FFB547` | `#0F1024` | 10.67:1 | 4.5:1 ✓ |
| dark | sky ink on sky 16-18% tint pill (over surface) | `#2EC5FF` | `#1E3A5D` | 5.80:1 | 4.5:1 ✓ |
| dark | sky ink on sky 16% tint (tab bar / pill over bg) | `#2EC5FF` | `#142D47` | 7.05:1 | 4.5:1 ✓ |
| dark | coral ink on coral 16-18% tint pill (over surface) | `#FF8A8A` | `#442A43` | 5.58:1 | 4.5:1 ✓ |
| dark | coral ink on coral 16% tint (tab bar / pill over bg) | `#FF8A8A` | `#351F2F` | 6.67:1 | 4.5:1 ✓ |
| dark | lime ink on lime 16-18% tint pill (over surface) | `#B8F23A` | `#37433A` | 7.80:1 | 4.5:1 ✓ |
| dark | lime ink on lime 16% tint (tab bar / pill over bg) | `#B8F23A` | `#2A3428` | 9.75:1 | 4.5:1 ✓ |
| dark | mango ink on mango 16-18% tint pill (over surface) | `#FFB547` | `#44383C` | 6.37:1 | 4.5:1 ✓ |
| dark | mango ink on mango 16% tint (tab bar / pill over bg) | `#FFB547` | `#352A2A` | 7.88:1 | 4.5:1 ✓ |
| light | Body text on bg | `#0F1024` | `#F7F7FB` | 17.55:1 | 4.5:1 ✓ |
| light | Secondary text on bg | `#4A4C68` | `#F7F7FB` | 7.78:1 | 4.5:1 ✓ |
| light | Body text on surface | `#0F1024` | `#FFFFFF` | 18.75:1 | 4.5:1 ✓ |
| light | Secondary text on surface | `#4A4C68` | `#FFFFFF` | 8.32:1 | 4.5:1 ✓ |
| light | Body text on s2 | `#0F1024` | `#EEEEF7` | 16.26:1 | 4.5:1 ✓ |
| light | Secondary text on s2 | `#4A4C68` | `#EEEEF7` | 7.21:1 | 4.5:1 ✓ |
| light | Muted labels (weekdays, placeholders) on surface | `#5D5F7D` | `#FFFFFF` | 6.18:1 | 4.5:1 ✓ |
| light | Muted labels on surface-2 (set inputs) | `#5D5F7D` | `#EEEEF7` | 5.36:1 | 4.5:1 ✓ |
| light | violet ink text on surface | `#5443D6` | `#FFFFFF` | 6.66:1 | 4.5:1 ✓ |
| light | violet ink text on bg | `#5443D6` | `#F7F7FB` | 6.24:1 | 4.5:1 ✓ |
| light | sky ink text on surface | `#086A92` | `#FFFFFF` | 6.02:1 | 4.5:1 ✓ |
| light | sky ink text on bg | `#086A92` | `#F7F7FB` | 5.64:1 | 4.5:1 ✓ |
| light | coral ink text on surface | `#B42A26` | `#FFFFFF` | 6.36:1 | 4.5:1 ✓ |
| light | coral ink text on bg | `#B42A26` | `#F7F7FB` | 5.96:1 | 4.5:1 ✓ |
| light | lime ink text on surface | `#3F6600` | `#FFFFFF` | 6.75:1 | 4.5:1 ✓ |
| light | lime ink text on bg | `#3F6600` | `#F7F7FB` | 6.32:1 | 4.5:1 ✓ |
| light | mango ink text on surface | `#8A5100` | `#FFFFFF` | 6.45:1 | 4.5:1 ✓ |
| light | mango ink text on bg | `#8A5100` | `#F7F7FB` | 6.03:1 | 4.5:1 ✓ |
| light | sky ink on sky 16-18% tint pill (over surface) | `#086A92` | `#D9F5FF` | 5.29:1 | 4.5:1 ✓ |
| light | sky ink on sky 16% tint (tab bar / pill over bg) | `#086A92` | `#D7EFFC` | 5.06:1 | 4.5:1 ✓ |
| light | coral ink on coral 16-18% tint pill (over surface) | `#B42A26` | `#FFE4E4` | 5.29:1 | 4.5:1 ✓ |
| light | coral ink on coral 16% tint (tab bar / pill over bg) | `#B42A26` | `#F8E1E4` | 5.12:1 | 4.5:1 ✓ |
| light | lime ink on lime 16-18% tint pill (over surface) | `#3F6600` | `#F2FDDC` | 6.38:1 | 4.5:1 ✓ |
| light | lime ink on lime 16% tint (tab bar / pill over bg) | `#3F6600` | `#EDF6DC` | 6.05:1 | 4.5:1 ✓ |
| light | mango ink on mango 16-18% tint pill (over surface) | `#8A5100` | `#FFF2DE` | 5.83:1 | 4.5:1 ✓ |
| light | mango ink on mango 16% tint (tab bar / pill over bg) | `#8A5100` | `#F8ECDE` | 5.54:1 | 4.5:1 ✓ |
| both | Navy text on coral fill (buttons, set numbers, chips, chart tooltip) | `#0F1024` | `#FF6B6B` | 6.76:1 | 4.5:1 ✓ |
| both | Navy text on mango fill (buttons, set numbers, chips, chart tooltip) | `#0F1024` | `#FFB547` | 10.67:1 | 4.5:1 ✓ |
| both | Navy text on lime fill (buttons, set numbers, chips, chart tooltip) | `#0F1024` | `#B8F23A` | 14.11:1 | 4.5:1 ✓ |
| both | Navy text on sky fill (buttons, set numbers, chips, chart tooltip) | `#0F1024` | `#2EC5FF` | 9.42:1 | 4.5:1 ✓ |
| both | Navy text on violet_tint fill (buttons, set numbers, chips, chart tooltip) | `#0F1024` | `#8C7CF0` | 5.59:1 | 4.5:1 ✓ |
| both | Navy text on primary gradient mid-point | `#0F1024` | `#5DA0F8` | 7.01:1 | 4.5:1 ✓ |
| both | Navy text on hot gradient mid-point (Finish, Share, PR toast) | `#0F1024` | `#FF9059` | 8.38:1 | 4.5:1 ✓ |
| both | Off-white text on navy CTA button | `#F7F7FB` | `#0F1024` | 17.55:1 | 4.5:1 ✓ |
| dark | Hero gradient headline, violet end on bg (large text) | `#6C5CE7` | `#0F1024` | 3.86:1 | 3.0:1 ✓ |
| dark | Hero gradient headline, sky end on bg (large text) | `#2EC5FF` | `#0F1024` | 9.42:1 | 3.0:1 ✓ |
| light | Hero gradient headline, violet-ink end on bg (large text) | `#5443D6` | `#F7F7FB` | 6.24:1 | 3.0:1 ✓ |
| light | Hero gradient headline, sky-ink end on bg (large text) | `#086A92` | `#F7F7FB` | 5.64:1 | 3.0:1 ✓ |
| both | Phone mockup secondary text #B9BBD6 on #1B1C3A | `#B9BBD6` | `#1B1C3A` | 8.75:1 | 4.5:1 ✓ |
| both | Share image secondary text #B9BBD6 on #1B1C3A card | `#B9BBD6` | `#1B1C3A` | 8.75:1 | 4.5:1 ✓ |

66 pairs, 0 below threshold

Ink colours on surface-2 (secondary buttons, inputs):

| Theme | Violet | Sky | Coral | Lime | Mango |
|---|---|---|---|---|---|
| dark (`#262849`) | 5.84 | 7.12 | 6.24 | 10.66 | 8.06 |
| light (`#EEEEF7`) | 5.78 | 5.22 | 5.52 | 5.85 | 5.59 |
