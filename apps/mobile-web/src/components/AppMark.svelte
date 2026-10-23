<script lang="ts">
  import icon from '../../../../brand/wicaby-app-icon.svg';

  let { size = 72 }: { size?: number } = $props();
</script>

<img src={icon} alt="" width={size} height={size} />
