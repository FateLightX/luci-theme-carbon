# Device traffic accounting / 每设备流量统计

## 中文

Carbon 首次检测时优先读取已有 nlbwmon，遵循其采集周期（默认通常 30 秒）。配置缺失、命令失败或返回数据不可用时，再尝试 nftables 的 `inet carbon_acct` 表中的命名计数器，每 5 秒计算一次字节差分。至少存在一组有效的上下行计数器才选用 nftables；两者都不可用时保留设备列表，不显示有效网速，约一分钟后重新检测。

不增加设置项。设备卡片显示实际来源，例如“设备网速 · nftables · 近 5 秒平均”。选定来源后，本页内保持不变；读取失败显示“不可用”，约一分钟后重试同一来源，不混用另一来源的累计值。刷新页面会重新按 nlbwmon 优先的顺序检测，安装或修改采集服务后可刷新生效。即使 nlbwmon 采集周期很长，读取失败时仍按一分钟重试。

这是对已有采集规则的兼容支持，不代表 [issue 10](https://github.com/mrjoechen/luci-theme-carbon/issues/10) 的漏算原因已确认。nlbwmon 能正常返回数据但本身统计不准时，自动检测无法判断其准确性，也不会改用 nftables。主题不自动创建规则、不修改防火墙和流量卸载设置。

### 配置示例

需要提供 JSON 输出的 `nft` 命令（OpenWrt 通常由 `nftables-json` 包提供）。以下是 **nft 配置文件内容**，不是 shell 脚本。管理员应将示例 IP 和 MAC 替换为实际设备的信息，并使用固定租约，避免 IP 转移后归属错误。每个设备需要两个命名计数器：

- `carbon_up_001122334455`：设备上传字节数，匹配源 IP。
- `carbon_down_001122334455`：设备下载字节数，匹配目的 IP。

MAC 使用 12 位小写十六进制，不带冒号。计数器本身位于 `inet carbon_acct` 表，规则通过 `counter name` 引用。已有同名表时请修改现有配置，不要重复创建或叠加计数规则。

```nft
table inet carbon_acct {
    counter carbon_up_001122334455 { }
    counter carbon_down_001122334455 { }

    chain forward {
        type filter hook forward priority 10; policy accept;
        ip saddr 192.168.1.100 counter name carbon_up_001122334455
        ip daddr 192.168.1.100 counter name carbon_down_001122334455
        ip6 saddr fd00::100 counter name carbon_up_001122334455
        ip6 daddr fd00::100 counter name carbon_down_001122334455
    }
}
```

将完整表定义保存在例如 `/etc/carbon-acct.nft` 中，先检查语法，再加载：

```bash
nft -c -f /etc/carbon-acct.nft
```

```bash
nft -f /etc/carbon-acct.nft
```

验证主题读取的数据：

```bash
nft -j list counters table inet carbon_acct
```

以上加载只作用于当前内核运行状态。持久化需通过所用固件支持的防火墙启动/重载机制加载该独立表，并处理重复加载和计数重置；完整 `table inet` 定义不能直接放进通常位于 `table inet fw4` 内部的 `/etc/nftables.d/*.nft` include。升级主题后，若固定查询被 ACL 拒绝，重启 rpcd 并重新登录 LuCI。

### 统计边界

- 该示例统计经过 forward 链的流量，包括跨网段内网流量。只统计互联网时，应按实际 WAN 入/出接口约束规则；PPPoE 应使用实际的三层接口名称。
- 每个地址只应命中一次同方向计数。设备有多个 IPv4/IPv6 地址时，可以用互不重叠的规则引用同一个计数器；IPv6 隐私地址变化时需更新规则。
- 软件/硬件 flow offload 可能绕过 forward 链。需要完整逐包统计时，应在防火墙设置中关闭相关卸载，并评估吞吐和 CPU 影响。单纯换用 nftables 不能保证所有环境都完整统计。
- 同网桥二层流量、路由器本身的 input/output 流量和经过其他网关的流量不在此示例范围内。
- 已选用 nftables 时，不再混合 nlbwmon 数据。没有完整上下行计数器的设备显示 `—`；计数器不能创建新的设备列表项。首次采样、来源切换、可检测的计数器重建或计数下降均重新建立基线。两次读取之间重置后又超过旧值的计数无法仅凭累计值识别；管理规则后刷新页面可强制重建基线。
- 选用 nftables 后，没有对应计数器的设备不会单独回退到 nlbwmon。主题无法补回任一采集来源未记录的流量。

## English

Carbon first tries an existing nlbwmon collector at its configured interval (normally 30 seconds). If its configuration, command or response is unavailable during initial discovery, Carbon tries named counters in the `inet carbon_acct` nftables table at a five-second interval. At least one valid upload/download pair is required. If neither source is available, discovery retries after about one minute and the device list stays usable without speed readings.

No settings control is added. The device card shows the actual source. Once selected, that source remains fixed for this page: a failed read shows unavailable and retries the same source after about one minute, regardless of its normal sampling interval. Reloading the page repeats discovery with nlbwmon first. This also lets newly installed collectors take effect. A successful nlbwmon response cannot reveal whether its accounting is accurate, so inaccurate totals do not trigger fallback.

This supports existing collectors; it does not establish the cause of issue 10. Carbon only reads counters and does not install rules or alter firewall/offload settings.

The nft configuration above uses two named counters per device: `carbon_up_<mac>` and `carbon_down_<mac>`, where `<mac>` is twelve lowercase hex digits without separators. Replace both the MAC and example IPv4/IPv6 addresses with the actual device values. Upload rules match source addresses; download rules match destination addresses. IPv4 and IPv6 rules may share the same named counter. Use stable leases and keep rules current as addresses change. Existing anonymous counters in a table named `carbon_acct` must be adapted to reference these named counters.

Use a JSON-capable `nft` binary (typically OpenWrt's `nftables-json` package). Save the full table definition, for example to `/etc/carbon-acct.nft`, check it with `nft -c -f`, then load it with `nft -f`, as shown above. Adapt an existing table instead of adding overlapping rules. The fixed read command is `nft -j list counters table inet carbon_acct`. After a theme upgrade, restart rpcd and log in again if its ACL rejects this query.

Loading a file affects the running kernel only. Persistence requires the firmware's firewall startup/reload mechanism, with duplicate loads and counter resets handled explicitly. Do not put this full table definition into `/etc/nftables.d/*.nft`, which is normally included inside `table inet fw4`.

The example counts forwarded traffic, including routed LAN-to-LAN traffic. Restrict rules to the actual WAN interfaces if internet-only totals are desired. Avoid overlapping matches for the same direction. Software/hardware flow offload can bypass the forward chain: disable relevant offloading when complete accounting is required, and evaluate CPU/throughput impact. Same-bridge traffic, router input/output and traffic through other gateways are outside this example's scope.

Once nftables is selected, nlbwmon totals are not mixed into it, even for devices without corresponding counters. Devices without both directions show `—`; counters never add discovered devices. Initial samples, source switches, detectable counter recreation and decreasing totals establish a fresh baseline. A reset followed by enough traffic to exceed the previous value between reads cannot be detected from totals alone; reload the page after managing rules to establish a fresh baseline. Without nftables configuration, the original nlbwmon undercount remains possible.
