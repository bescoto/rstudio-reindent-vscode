object %>%
  {
    stuff1
  } %>% object[index] %>% {stuff2} %>% fun_call1() +
  {if (condition1) stuff3 else stuff4} +
  if (condition2) {
    stuff5
  } else if (condition3) {
    stuff6
  } else {
    stuff7
  } %>%
  (fun_call2()) %>% fun_call3() %>%
  fun_call3()
